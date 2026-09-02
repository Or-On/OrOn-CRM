"""Async dispatcher adapter for the retained per-call Pipecat engine."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from contextlib import suppress

from oron_common import CallContext
from pydantic import BaseModel, ConfigDict
from renikud_onnx import G2P

from oron_agent.bot import require_real_voice_providers, run_call
from oron_agent.config import AgentOverrides, Settings


class AgentTaskHandle(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    task: asyncio.Task[None]

    async def cancel(self) -> None:
        if self.task.done():
            with suppress(asyncio.CancelledError):
                self.task.result()
            return
        self.task.cancel()
        with suppress(asyncio.CancelledError):
            await self.task


def make_launch_bot(settings: Settings, *, g2p: G2P | None = None):
    """Return the dispatcher port, preflighting the provider gate before launch."""

    async def launch_bot(
        room: str,
        context: CallContext,
        overrides: Mapping[str, object] | None = None,
    ) -> AgentTaskHandle:
        require_real_voice_providers(settings)
        parsed_overrides = AgentOverrides.model_validate(overrides) if overrides else None
        task = asyncio.create_task(
            run_call(room, context, settings, g2p=g2p, overrides=parsed_overrides),
            name=f"oron-agent:{context.session_id}",
        )
        return AgentTaskHandle(task=task)

    return launch_bot
