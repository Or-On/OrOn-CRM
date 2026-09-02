from unittest.mock import AsyncMock, patch

import pytest
from or_on_platform.config import PlatformSettings
from oron_agent.bot import RealVoiceProvidersDenied
from oron_agent.config import Settings
from voice_agent_runtime.main import run


async def test_standalone_runtime_denies_before_agent_or_model_construction() -> None:
    platform = PlatformSettings(PLATFORM_ENV="test")
    with (
        patch("oron_hebrew.build_g2p") as build_g2p,
        patch("oron_agent.bot.bot", new=AsyncMock()) as bot,
        pytest.raises(RealVoiceProvidersDenied, match="disabled"),
    ):
        await run(platform_settings=platform, agent_settings=Settings(_env_file=None))
    build_g2p.assert_not_called()
    bot.assert_not_awaited()
