"""Provider-gated standalone entrypoint for the retained Or-on voice agent."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from or_on_platform.config import PlatformSettings
from or_on_platform.logging import configure_logging

if TYPE_CHECKING:
    from oron_agent.config import Settings


async def run(
    *,
    platform_settings: PlatformSettings | None = None,
    agent_settings: Settings | None = None,
) -> None:
    try:
        from oron_agent.bot import bot, require_real_voice_providers
        from oron_agent.config import Settings
        from oron_hebrew import build_g2p
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "voice dependencies are not installed; run `uv sync --group voice`"
        ) from error
    platform = platform_settings or PlatformSettings.load(service="voice-agent")
    agent = agent_settings or Settings()
    require_real_voice_providers(agent)
    logger = configure_logging(
        service="voice-agent", environment=platform.environment, level=platform.log_level
    )
    logger.info("voice_agent_starting", extra={"fields": agent.diagnostics()})
    g2p = build_g2p(
        agent.renikud_model_path,
        expected_sha256=agent.renikud_model_sha256,
    )
    await bot(g2p=g2p)


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
