"""Dispatcher process entrypoint; provider actions remain disabled by default."""

from __future__ import annotations

import uvicorn
from or_on_platform.config import PlatformSettings
from or_on_platform.logging import configure_logging
from oron_dispatcher.config import DispatcherSettings

from dispatcher_runtime.app import build


def main() -> None:
    settings = PlatformSettings.load(service="dispatcher")
    dispatcher_settings = DispatcherSettings()
    logger = configure_logging(
        service="dispatcher", environment=settings.environment, level=settings.log_level
    )
    logger.info(
        "dispatcher_starting",
        extra={
            "fields": {
                **dispatcher_settings.diagnostics(),
                "voice_agent_adapter": "retained-launcher-available",
                "full_runtime_composition": "pending-p5-012",
            }
        },
    )
    uvicorn.run(
        build(platform_settings=settings, dispatcher_settings=dispatcher_settings),
        host=dispatcher_settings.bind_host,
        port=dispatcher_settings.port,
    )


if __name__ == "__main__":
    main()
