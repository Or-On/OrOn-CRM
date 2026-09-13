import asyncio
import logging
import uuid
from http import HTTPMethod, HTTPStatus

import httpx
from oron_common import CallContext, CallUsage
from oron_flows import FlowSpec
from pydantic import ValidationError

from oron_sessions.models import SessionCreate, SessionStatus, SessionUpdate

logger = logging.getLogger(__name__)

# The API is unreachable or unwell — worth another attempt. A 4xx is permanent;
# retrying a 409 or 422 only burns time inside a live call.
RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})


class SessionsClient:
    """Async HTTP client for the oron-sessions API.

    Best-effort by design: every method logs and returns a falsy value on failure
    rather than raising. Persistence is secondary to the call — a sessions API
    outage must never be what ends a conversation.
    """

    def __init__(
        self,
        base_url: str,
        client: httpx.AsyncClient | None = None,
        *,
        api_key: str | None = None,
        timeout_seconds: float = 10.0,
        attempts: int = 3,
        backoff_seconds: float = 0.2,
    ):
        self._base_url = base_url.rstrip("/")
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else None
        self._client = client or httpx.AsyncClient(
            base_url=self._base_url, timeout=timeout_seconds, headers=headers
        )
        self._owns_client = client is None
        self._attempts = attempts
        self._backoff_seconds = backoff_seconds

    async def _send(
        self,
        method: HTTPMethod,
        url: str,
        payload: dict | None = None,
        headers: dict | None = None,
        *,
        expected: frozenset[HTTPStatus] = frozenset(),
    ) -> httpx.Response | None:
        """Send with bounded retries. Returns the response on success, or None if
        the request could not be completed — transport error, retries exhausted,
        or a permanent 4xx. The reason is logged here, so callers only branch on
        None instead of re-deriving success and re-formatting the failure.

        `expected` names failure statuses the caller reads a meaning off rather
        than treating as a failure; they come back as the response, unlogged."""
        delay = self._backoff_seconds
        reason = "no attempt made"
        for attempt in range(1, self._attempts + 1):
            try:
                resp = await self._client.request(method, url, json=payload, headers=headers)
            except httpx.HTTPError as exc:
                reason = type(exc).__name__
            else:
                if resp.is_success or resp.status_code in expected:
                    return resp
                reason = f"HTTP {resp.status_code}"
                if resp.status_code not in RETRYABLE_STATUS:
                    break  # permanent — retrying only burns time inside a live call
            if attempt < self._attempts:
                await asyncio.sleep(delay)
                delay *= 2
        logger.warning("%s %s failed (%s)", method, url, reason)
        return None

    async def create(self, ctx: CallContext, *, room: str) -> uuid.UUID | None:
        """Returns the id of the session row to report against, or None if there
        is none to report against.

        The tenant is taken off `ctx` rather than passed in: a service key is
        rejected outright without `X-Tenant-Id`, and every caller holds the
        context already, so a parameter here is only somewhere to forget it. A
        tenant-key caller sends it too and the server ignores it.

        A 409 counts as success. It means the row already exists — the dispatcher
        creates one when it launches the agent, which then posts the same
        session_id — and that is the row the caller goes on to finalize.
        """
        body = SessionCreate(
            session_id=ctx.session_id,
            provider=ctx.provider,
            direction=ctx.direction,
            from_number=ctx.from_number,
            to_number=ctx.to_number,
            room=room,
            flow_id=ctx.flow_id,
        )
        resp = await self._send(
            HTTPMethod.POST,
            "/sessions",
            body.model_dump(mode="json"),
            headers={"X-Tenant-Id": str(ctx.tenant_id)},
            expected=frozenset({HTTPStatus.CONFLICT}),
        )
        if resp is None:
            logger.warning(
                "session %s not recorded; the call continues without a session row",
                ctx.session_id,
            )
            return None
        if resp.status_code == HTTPStatus.CONFLICT:
            return ctx.session_id
        return uuid.UUID(resp.json()["session_id"])

    async def finalize(
        self,
        session_id: uuid.UUID,
        *,
        status: SessionStatus = SessionStatus.ENDED,
        answered: bool | None = None,
        outcome: str | None = None,
        recording_uri: str | None = None,
        transcript_uri: str | None = None,
        tenant_id: uuid.UUID | None = None,
        usage: CallUsage | None = None,
    ) -> bool:
        """Returns True if the session was finalized. On False the row keeps its
        `started` status and the stale-session sweeper will fail it later.

        `tenant_id` is sent as `X-Tenant-Id` for service-key callers (the
        dispatcher); tenant-key callers omit it and the server derives it."""
        body = SessionUpdate(
            status=status,
            answered=answered,
            outcome=outcome,
            recording_uri=recording_uri,
            transcript_uri=transcript_uri,
            usage=usage,
        )
        headers = {"X-Tenant-Id": str(tenant_id)} if tenant_id else None
        resp = await self._send(
            HTTPMethod.PATCH,
            f"/sessions/{session_id}",
            body.model_dump(mode="json", exclude_none=True),
            headers=headers,
        )
        if resp is None:
            logger.warning(
                "session %s not finalized; the stale-session sweeper will fail it later",
                session_id,
            )
            return False
        return True

    async def checkpoint_usage(
        self,
        session_id: uuid.UUID,
        *,
        tenant_id: uuid.UUID,
        usage: CallUsage,
    ) -> bool:
        """Persist an in-progress usage snapshot without finalizing the call.

        The same tenant-scoped PATCH path owns both checkpoints and the final
        write. A failed checkpoint is best-effort: it must not interrupt audio,
        and the final write still carries the complete counters.
        """
        resp = await self._send(
            HTTPMethod.PATCH,
            f"/sessions/{session_id}",
            SessionUpdate(usage=usage).model_dump(mode="json", exclude_none=True),
            headers={"X-Tenant-Id": str(tenant_id)},
        )
        return resp is not None

    async def get_flow(self, flow_id: uuid.UUID, *, tenant_id: uuid.UUID) -> FlowSpec | None:
        """The frozen spec this call should run, or None if it could not be fetched.

        Unlike best-effort session writes, a flow is executable configuration.
        The voice runtime treats None as fatal and must not substitute packaged
        behavior after a missing, unreachable, or invalid database response.
        """
        resp = await self._send(
            HTTPMethod.GET, f"/flows/{flow_id}", headers={"X-Tenant-Id": str(tenant_id)}
        )
        if resp is None:
            return None
        try:
            return FlowSpec.model_validate(resp.json())
        except ValidationError as exc:
            # A spec the store served but this build cannot parse: the component
            # library moved on. Say so without logging the rejected definition.
            logger.warning(
                "flow %s did not validate against this build (%d validation errors)",
                flow_id,
                exc.error_count(),
            )
            return None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()
