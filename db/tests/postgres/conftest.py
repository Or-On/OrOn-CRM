from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

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


def _database_url_with_name(url: str, database_name: str) -> str:
    parsed = urlsplit(url)
    return urlunsplit((parsed.scheme, parsed.netloc, f"/{database_name}", parsed.query, ""))


async def run_alembic(
    database_url: str, *arguments: str, extra_env: dict[str, str] | None = None
) -> None:
    environment = dict(os.environ)
    environment["DATABASE_URL"] = database_url
    if extra_env:
        environment.update(extra_env)

    def run() -> None:
        subprocess.run(  # noqa: S603
            [
                sys.executable,
                "-m",
                "alembic",
                "-c",
                str(ROOT / "db" / "alembic" / "alembic.ini"),
                *arguments,
            ],
            cwd=ROOT,
            env=environment,
            check=True,
            capture_output=True,
            text=True,
        )

    await asyncio.to_thread(run)


@pytest_asyncio.fixture
async def isolated_postgres_url(postgres_url: str) -> AsyncIterator[str]:
    """Create a disposable database for history-changing migration tests."""

    database_name = f"or_on_platform_phase2b_{uuid4().hex}"
    admin_url = _database_url_with_name(postgres_url, "postgres")
    admin = await asyncpg.connect(admin_url)
    try:
        await admin.execute(f'CREATE DATABASE "{database_name}"')  # noqa: S608
        yield _database_url_with_name(postgres_url, database_name)
    finally:
        await admin.execute(  # noqa: S608
            f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)'
        )
        await admin.close()
