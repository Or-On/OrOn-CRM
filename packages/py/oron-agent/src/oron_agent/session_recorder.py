import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable

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
        self._finish_lock = asyncio.Lock()
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
    ) -> bool:
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
        async with self._finish_lock:
            if not self._recorded:
                return False
            if self._finalized:
                return True
            await self._stop_usage_reporting()
            session_id = self._ctx.session_id
            persisted = await self._client.finalize(
                session_id,
                status=status,
                answered=answered,
                outcome=outcome,
                recording_uri=self._store.uri(session_id, RECORDING_PATH),
                transcript_uri=self._store.uri(session_id, TRANSCRIPT_PATH),
                tenant_id=self._ctx.tenant_id,
                usage=usage,
            )
            # A cancelled or rejected persistence attempt must remain retryable.
            # The dispatcher can finish the room while the agent is committing
            # artifacts; marking this before the await previously left copied
            # files with permanently NULL recording/transcript pointers.
            if persisted:
                self._finalized = True
            return persisted

    async def aclose(self) -> None:
        await self._stop_usage_reporting()
        await self._client.aclose()


async def finish_after_cancellation(
    finalize: Callable[[], Awaitable[bool]],
    *,
    timeout_seconds: float = 30.0,
    attempts: int = 3,
    retry_delay_seconds: float = 0.25,
) -> bool:
    """Complete bounded teardown even after the owning call task is cancelled.

    LiveKit's room-finished webhook and the transport's participant-left event
    race by design. The dispatcher cancels the in-process agent for the former;
    without shielding, that cancellation can land after files are copied but
    before their database pointers are committed. Repeated cancellation remains
    deferred until this cleanup task completes, then the caller re-raises the
    original cancellation.
    """

    async def run_finalize() -> bool:
        for attempt in range(max(1, attempts)):
            try:
                if await finalize():
                    return True
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "voice call finalization attempt %d failed",
                    attempt + 1,
                )
            if attempt + 1 < max(1, attempts):
                await asyncio.sleep(max(0.0, retry_delay_seconds))
        return False

    cleanup = asyncio.create_task(run_finalize(), name="voice-call-finalization")
    deadline = asyncio.get_running_loop().time() + max(0.0, timeout_seconds)
    while not cleanup.done():
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            cleanup.cancel()

            def consume_result(task: asyncio.Task[bool]) -> None:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    task.exception()

            cleanup.add_done_callback(consume_result)
            logger.error("voice call finalization exceeded %.1fs", timeout_seconds)
            return False
        try:
            await asyncio.wait({cleanup}, timeout=remaining)
        except asyncio.CancelledError:
            continue
    try:
        return await cleanup
    except Exception:
        logger.exception("voice call finalization failed during cancellation cleanup")
        return False
