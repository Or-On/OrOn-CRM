from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import asyncpg
import pytest
import pytest_asyncio

ROOT = Path(__file__).parents[3]
MANIFEST_PATH = ROOT / "db" / "contracts" / "schema-manifest.json"


@pytest.fixture(scope="session")
def postgres_url() -> str:
    value = os.environ.get("TEST_DATABASE_URL")
    if not value:
        pytest.skip("PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B")
    normalized = value.replace("postgresql+asyncpg://", "postgresql://", 1)
    if not normalized.startswith("postgresql://"):
        pytest.fail("TEST_DATABASE_URL must point to PostgreSQL")
    return normalized


@pytest.fixture(scope="session")
def schema_manifest() -> dict[str, Any]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


@pytest_asyncio.fixture
async def pg(postgres_url: str) -> AsyncIterator[asyncpg.Connection]:
    connection = await asyncpg.connect(postgres_url)
    transaction = connection.transaction()
    await transaction.start()
    try:
        yield connection
    finally:
        await transaction.rollback()
        await connection.close()
