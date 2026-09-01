"""Idempotent, PII-free Phase 1 development seed."""

from __future__ import annotations

import asyncio
import os

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
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
            statement = text(
                """
                    INSERT INTO platform.system_metadata (key, value)
                    VALUES (:key, :value)
                    ON CONFLICT (key) DO UPDATE
                    SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
                    """
            ).bindparams(bindparam("value", type_=JSONB))
            await connection.execute(
                statement,
                {"key": "foundation_version", "value": "phase-1"},
            )
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed())
