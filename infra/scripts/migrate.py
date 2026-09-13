"""One-shot migration, serialized across release processes. Never seeds accounts."""

from __future__ import annotations

import asyncio
import os
import re
import sys

import asyncpg


async def migrate() -> None:
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql://"):
        raise RuntimeError("DATABASE_URL must be explicit PostgreSQL migration credentials")
    passwords = {}
    for role in ("platform_web", "platform_voice", "platform_messaging"):
        password = os.environ.get(f"{role.upper()}_PASSWORD", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", password):
            raise RuntimeError(f"{role.upper()}_PASSWORD must be 32-128 URL-safe characters")
        passwords[role] = password
    connection = await asyncpg.connect(url, timeout=10)
    try:
        # Session-level lock spans the Alembic child connection; no concurrent DDL runner.
        locked = await connection.fetchval("SELECT pg_try_advisory_lock(726443819442)")
        if not locked:
            raise RuntimeError("Another migration process holds the release lock")
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "alembic", "-c", "db/alembic/alembic.ini", "upgrade", "head"
        )
        if await process.wait():
            raise RuntimeError("Migration failed; retain backup and do not start the new release")
        for role, password in passwords.items():
            # Both interpolated values are a fixed allowlist / restrictive validated alphabet.
            # Passwords are process configuration, never baked into migration history.
            await connection.execute(
                f"ALTER ROLE {role} LOGIN PASSWORD '{password}' "  # noqa: S608
                "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"
            )
    finally:
        await connection.close()


if __name__ == "__main__":
    asyncio.run(migrate())
