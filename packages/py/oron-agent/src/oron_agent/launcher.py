"""Async dispatcher adapter for the retained per-call Pipecat engine."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from contextlib import suppress

from oron_common import CallContext
from pydantic import BaseModel, ConfigDict
from renikud_onnx import G2P

from oron_agent.bot import require_real_voice_providers, run_call
from oron_agent.config import AgentOverrides, Settings
from oron_agent.llm import verify_llm_access
from oron_agent.runtime_sessions import RuntimeSessions

Preflight = Callable[[Settings], Awaitable[None]]


class AgentTaskHandle(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    task: asyncio.Task[None]

    def observe_completion(self, callback: Callable[[BaseException | None], None]) -> None:
        """Report an unexpected runtime exit to the owning dispatcher.

        A detached task can fail after admission but before the transport has
        joined the room.  Without this hook the SIP leg can keep running in
        silence while the canonical session remains falsely ``started``.
        """

        def completed(task: asyncio.Task[None]) -> None:
            if task.cancelled():
                callback(None)
                return
            callback(task.exception())

        self.task.add_done_callback(completed)

    async def cancel(self) -> None:
        if self.task.done():
            with suppress(asyncio.CancelledError):
                self.task.result()
            return
        self.task.cancel()
        with suppress(asyncio.CancelledError):
            await self.task


def make_launch_bot(
    settings: Settings,
    *,
    g2p: G2P | None = None,
    sessions: RuntimeSessions | None = None,
    preflight: Preflight = verify_llm_access,
):
    """Return the dispatcher port, preflighting providers before a paid call."""

    preflight_complete = False
    preflight_lock = asyncio.Lock()

    async def ensure_preflight() -> None:
        nonlocal preflight_complete
        if preflight_complete:
            return
        async with preflight_lock:
            if preflight_complete:
                return
            await preflight(settings)
            preflight_complete = True

    async def launch_bot(
        room: str,
        context: CallContext,
        overrides: Mapping[str, object] | None = None,
    ) -> AgentTaskHandle:
        require_real_voice_providers(settings)
        await ensure_preflight()
        parsed_overrides = AgentOverrides.model_validate(overrides) if overrides else None
        ready = asyncio.Event()
        task = asyncio.create_task(
            run_call(
                room,
                context,
                settings,
                g2p=g2p,
                overrides=parsed_overrides,
                sessions=sessions,
                ready=ready,
            ),
            name=f"oron-agent:{context.session_id}",
        )
        ready_wait = asyncio.create_task(
            ready.wait(), name=f"oron-agent-ready:{context.session_id}"
        )
        try:
            done, _ = await asyncio.wait(
                {task, ready_wait},
                timeout=15.0,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if task in done:
                # Re-raise construction/connection failures before the paid SIP
                # leg is created.  The dispatcher maps the detail to a safe
                # public startup error and persists the failed session.
                await task
                raise RuntimeError("voice agent stopped before becoming ready")
            if ready_wait not in done:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
                raise TimeoutError("voice agent readiness timed out")
        finally:
            ready_wait.cancel()
            with suppress(asyncio.CancelledError):
                await ready_wait
        return AgentTaskHandle(task=task)

    return launch_bot
