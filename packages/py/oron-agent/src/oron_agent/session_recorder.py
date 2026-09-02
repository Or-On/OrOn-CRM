from oron_common import CallContext, CallUsage
from oron_sessions import SessionsClient, SessionStatus

from oron_agent.storage import RECORDING_PATH, TRANSCRIPT_PATH, ArtifactStore


class SessionRecorder:
    """Owns one call's session row for the life of that call.

    Holds `recorded`/`finalized` as instance state rather than closure flags, so
    the transport handlers stay free of `nonlocal` bookkeeping.
    """

    def __init__(self, client: SessionsClient, ctx: CallContext, store: ArtifactStore):
        self._client = client
        self._ctx = ctx
        self._store = store
        self._recorded = False
        self._finalized = False

    async def start(self, *, room: str) -> None:
        self._recorded = await self._client.create(self._ctx, room=room) is not None

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
        await self._client.aclose()
