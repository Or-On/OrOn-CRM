"""Persist content-free quality recovery evidence and report bounded failures."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path

logger = logging.getLogger(__name__)
_MAX_QUALITY_BYTES = 262144


def stage_quality_snapshot(directory: Path, summary: dict) -> None:
    """Only pass VoiceQualityObserver output; customer text is never input here."""
    encoded = json.dumps(summary, separators=(",", ":"), allow_nan=False).encode()
    if len(encoded) > _MAX_QUALITY_BYTES:
        raise ValueError("quality recovery artifact exceeds its bound")
    destination = directory / "diagnostics" / "voice-quality.json"
    temporary = destination.with_suffix(".json.tmp")
    temporary.write_bytes(encoded)
    temporary.replace(destination)


async def persist_quality_summary(
    write: Callable[[], Awaitable[None]],
    report_failure: Callable[[], Awaitable[None]] | None,
) -> bool:
    """Derived failure cannot overwrite canonical finalization or invent success."""
    try:
        async with asyncio.timeout(2):
            await write()
        return True
    except Exception:
        logger.warning("voice quality summary persistence unavailable")
    if report_failure is not None:
        try:
            async with asyncio.timeout(2):
                await report_failure()
        except Exception:
            # Missing/deleted sessions have no trustworthy tenant binding. Keep
            # staged recovery data and this static warning, never fabricate an alert.
            logger.warning("voice quality failure alert unavailable")
    return False
