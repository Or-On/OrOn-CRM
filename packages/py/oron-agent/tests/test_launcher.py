import asyncio
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from oron_agent.bot import RealVoiceProvidersDenied
from oron_agent.config import Settings
from oron_agent.launcher import make_launch_bot
from oron_common import CallContext


def _context() -> CallContext:
    return CallContext(
        call_id="fixture",
        direction="browser",
        flow_id=uuid.uuid4(),
        tenant_id=uuid.uuid4(),
    )


async def test_launcher_denies_before_creating_a_task_when_providers_are_disabled() -> None:
    launch = make_launch_bot(Settings(_env_file=None))
    with (
        patch("oron_agent.launcher.asyncio.create_task") as create_task,
        pytest.raises(RealVoiceProvidersDenied, match="disabled"),
    ):
        await launch("fixture", _context(), None)
    create_task.assert_not_called()


async def test_launcher_runs_one_cancellable_task_for_an_enabled_call() -> None:
    settings = Settings(
        _env_file=None,
        ENABLE_REAL_VOICE_PROVIDERS=True,
        LIVEKIT_URL="ws://127.0.0.1:7880",
        LIVEKIT_API_KEY="fixture",
        LIVEKIT_API_SECRET="fixture-secret",
        SONIOX_API_KEY="fixture-soniox",
        GOOGLE_CLOUD_PROJECT="fixture-project",
    )
    started = asyncio.Event()

    async def wait_forever(*_args, **_kwargs) -> None:
        started.set()
        await asyncio.Event().wait()

    with patch("oron_agent.launcher.run_call", new=AsyncMock(side_effect=wait_forever)):
        handle = await make_launch_bot(settings)("fixture", _context(), None)
        await started.wait()
        await handle.cancel()
        assert handle.task.cancelled()
