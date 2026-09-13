import asyncio
import contextlib
import logging
import time

from oron_common import CallContext, CallUsage
from oron_sessions import SessionStatus

from oron_agent.runtime_sessions import RuntimeSessions
from oron_agent.storage import RECORDING_PATH, TRANSCRIPT_PATH, ArtifactStore

logger = logging.getLogger(__name__)


class SessionRecorder:
    """Owns one call's session row for the life of that call.

    Holds `recorded`/`finalized` as instance state rather than closure flags, so
    the transport handlers stay free of `nonlocal` bookkeeping.
    """

    def __init__(self, client: RuntimeSessions, ctx: CallContext, store: ArtifactStore):
        self._client = client
        self._ctx = ctx
        self._store = store
        self._recorded = False
        self._finalized = False
        self._usage_task: asyncio.Task[None] | None = None

    async def start(self, *, room: str) -> None:
        self._recorded = await self._client.create(self._ctx, room=room) is not None

    def start_usage_reporting(
        self,
        usage: CallUsage,
        *,
        started_at: float,
        interval_seconds: float = 1.0,
    ) -> None:
        """Checkpoint a live cost snapshot while preserving the final write.

        The task only starts after the durable session row exists. Each snapshot
        copies the counters accumulated by the pipeline observer and adds live
        talk time; checkpoint failures are reporting degradation, never a reason
        to interrupt the customer conversation.
        """
        if not self._recorded or self._usage_task is not None:
            return
        self._usage_task = asyncio.create_task(
            self._report_usage(
                usage,
                started_at=started_at,
                interval_seconds=interval_seconds,
            ),
            name=f"voice-usage-{self._ctx.session_id}",
        )

    async def _report_usage(
        self,
        usage: CallUsage,
        *,
        started_at: float,
        interval_seconds: float,
    ) -> None:
        while True:
            await asyncio.sleep(interval_seconds)
            snapshot = usage.model_copy(deep=True)
            snapshot.call_seconds = max(0.0, time.monotonic() - started_at)
            try:
                await self._client.checkpoint_usage(
                    self._ctx.session_id,
                    tenant_id=self._ctx.tenant_id,
                    usage=snapshot,
                )
            except Exception:
                logger.warning(
                    "live usage checkpoint failed for session %s",
                    self._ctx.session_id,
                )

    async def _stop_usage_reporting(self) -> None:
        task, self._usage_task = self._usage_task, None
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    async def finish(
        self,
        status: SessionStatus,
        usage: CallUsage,
        *,
        answered: bool | None = None,
        outcome: str | None = None,
    ) -> None:
        """Finalize at most once, so a clean end is never overwritten by a
        teardown error and vice versa. No-op if no row was ever created —
        PATCHing a session the API never accepted is a guaranteed 404.

        Artifact URIs come from the store rather than being passed in, so both
        are always present, a caller cannot forget or mistype one, and the
        scheme recorded always matches the backend the bytes actually went to.
        They are written on the failed path too: a call that died may still have
        uploaded a partial artifact, so absence is discovered from the object not
        being there rather than inferred from a null column.
        """
        if not self._recorded or self._finalized:
            return
        self._finalized = True
        await self._stop_usage_reporting()
        session_id = self._ctx.session_id
        await self._client.finalize(
            session_id,
            status=status,
            answered=answered,
            outcome=outcome,
            recording_uri=self._store.uri(session_id, RECORDING_PATH),
            transcript_uri=self._store.uri(session_id, TRANSCRIPT_PATH),
            tenant_id=self._ctx.tenant_id,
            usage=usage,
        )

    async def aclose(self) -> None:
        await self._stop_usage_reporting()
        await self._client.aclose()
