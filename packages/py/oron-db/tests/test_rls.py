import os
import uuid

import pytest
from oron_db import set_tenant
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Sourced from the environment / .env (loaded by the root conftest), never
# hardcoded. TEST_DATABASE_URL is the superuser DSN.
DB_URL = os.getenv("TEST_DATABASE_URL")

pytestmark = [pytest.mark.postgres, pytest.mark.rls]


def _asyncpg_url(value: str) -> str:
    if value.startswith("postgresql://"):
        return value.replace("postgresql://", "postgresql+asyncpg://", 1)
    return value


async def test_set_tenant_sets_the_guc():
    if DB_URL is None:
        pytest.skip("requires TEST_DATABASE_URL and real PostgreSQL")
    engine = create_async_engine(_asyncpg_url(DB_URL))
    sm = async_sessionmaker(engine, class_=AsyncSession)
    tid = uuid.uuid4()
    async with sm() as s:
        await set_tenant(s, tid)
        got = (
            await s.execute(text("SELECT current_setting('app.current_tenant', true)"))
        ).scalar_one()
        assert got == str(tid)
    await engine.dispose()
