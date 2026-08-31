"""PostgreSQL connectivity primitives owned by process composition roots."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine


@dataclass(slots=True)
class DatabaseProbe:
    """A mandatory PostgreSQL readiness dependency with explicit lifecycle."""

    engine: AsyncEngine

    async def is_ready(self) -> bool:
        try:
            async with self.engine.connect() as connection:
                await connection.execute(text("SELECT 1"))
        except Exception:  # noqa: BLE001 - readiness converts dependency failure to false
            return False
        return True

    async def close(self) -> None:
        await self.engine.dispose()


def create_database_probe(database_url: str) -> DatabaseProbe:
    """Create a non-global async probe and normalize SQLAlchemy's driver scheme."""

    normalized = database_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return DatabaseProbe(
        engine=create_async_engine(normalized, pool_pre_ping=True, pool_size=2, max_overflow=0)
    )
