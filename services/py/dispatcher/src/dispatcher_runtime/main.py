"""Dependency-safe placeholder lifecycle; no telephony behavior is implemented."""

from __future__ import annotations

import asyncio
import signal

from or_on_platform.config import PlatformSettings
from or_on_platform.database import DatabaseProbe, create_database_probe
from or_on_platform.logging import configure_logging


async def check_readiness(probe: DatabaseProbe) -> bool:
    return await probe.is_ready()


async def run() -> None:
    settings = PlatformSettings.load(require_database=True, service="dispatcher")
    assert settings.database_url is not None
    logger = configure_logging(
        service="dispatcher", environment=settings.environment, level=settings.log_level
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
        if not await check_readiness(probe):
            raise RuntimeError("dispatcher is not ready: PostgreSQL is unavailable")
        logger.info("worker_ready", extra={"fields": {"provider_actions": "disabled"}})
        await stop.wait()
    finally:
        await probe.close()
        logger.info("worker_stopped")


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
