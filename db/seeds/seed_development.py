"""Idempotent, PII-free Phase 1 development seed."""

from __future__ import annotations

import asyncio
import os

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine


def _database_url() -> str:
    value = os.environ.get("DATABASE_URL")
    if value is None or not value.startswith(("postgresql://", "postgresql+asyncpg://")):
        raise RuntimeError("DATABASE_URL must be a PostgreSQL URL")
    return value.replace("postgresql://", "postgresql+asyncpg://", 1)


async def seed() -> None:
    engine = create_async_engine(_database_url())
    try:
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    """
                    INSERT INTO platform.system_metadata (key, value)
                    VALUES ('foundation_version', 'phase-1')
                    ON CONFLICT (key) DO UPDATE
                    SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
                    """
                )
            )
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed())
