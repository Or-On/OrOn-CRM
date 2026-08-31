"""Dependency-safe placeholder lifecycle; no call behavior is implemented."""

from __future__ import annotations

import asyncio
import signal

from or_on_platform.config import PlatformSettings
from or_on_platform.database import create_database_probe
from or_on_platform.logging import configure_logging


async def run() -> None:
    settings = PlatformSettings.load(require_database=True, service="voice-agent")
    assert settings.database_url is not None
    logger = configure_logging(
        service="voice-agent", environment=settings.environment, level=settings.log_level
    )
    probe = create_database_probe(str(settings.database_url))
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signal_name in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signal_name, stop.set)
        except NotImplementedError:
            signal.signal(signal_name, lambda *_: loop.call_soon_threadsafe(stop.set))
    try:
        if not await probe.is_ready():
            raise RuntimeError("voice-agent is not ready: PostgreSQL is unavailable")
        logger.info(
            "worker_ready",
            extra={
                "fields": {
                    "telephony_enabled": settings.enable_real_telephony,
                    "calls_placed": 0,
                }
            },
        )
        await stop.wait()
    finally:
        await probe.close()
        logger.info("worker_stopped")


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
