"""Idempotent, PII-free Phase 1 development seed."""

from __future__ import annotations

import asyncio
import os
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import create_async_engine


def _database_url() -> str:
    value = os.environ.get("DATABASE_URL")
    if value is None or not value.startswith(("postgresql://", "postgresql+asyncpg://")):
        raise RuntimeError("DATABASE_URL must be a PostgreSQL URL")
    return value.replace("postgresql://", "postgresql+asyncpg://", 1)


async def seed() -> None:
    password_hash = os.environ.get("DEV_AUTH_PASSWORD_HASH")
    email = os.environ.get("DEV_AUTH_EMAIL", "operator@or-on.local")
    if not password_hash or not password_hash.startswith("$argon2id$"):
        raise RuntimeError("DEV_AUTH_PASSWORD_HASH must be a generated Argon2id hash")
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
                {"key": "foundation_version", "value": "phase-3"},
            )
            primary_tenant = UUID("10000000-0000-4000-8000-000000000001")
            secondary_tenant = UUID("10000000-0000-4000-8000-000000000002")
            user_id = UUID("20000000-0000-4000-8000-000000000001")
            await connection.execute(
                text(
                    """
                    INSERT INTO tenants (id, name, slug, status)
                    VALUES (:primary, 'Aurora Operations', 'aurora-operations', 'active'),
                           (:secondary, 'Northstar Studio', 'northstar-studio', 'active')
                    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = 'active'
                    """
                ),
                {"primary": primary_tenant, "secondary": secondary_tenant},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO users (id, email, status)
                    VALUES (:user_id, :email, 'active')
                    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, status = 'active'
                    """
                ),
                {"user_id": user_id, "email": email},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO memberships (user_id, tenant_id, role)
                    VALUES (:user_id, :primary, 'owner'), (:user_id, :secondary, 'admin')
                    ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role
                    """
                ),
                {"user_id": user_id, "primary": primary_tenant, "secondary": secondary_tenant},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO platform.auth_credentials (user_id, password_hash)
                    VALUES (:user_id, :password_hash)
                    ON CONFLICT (user_id) DO UPDATE
                    SET password_hash = EXCLUDED.password_hash,
                        failed_attempts = 0, locked_until = NULL,
                        updated_at = CURRENT_TIMESTAMP
                    """
                ),
                {"user_id": user_id, "password_hash": password_hash},
            )
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed())
