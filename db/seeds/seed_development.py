"""Idempotent development identity bootstrap without product demo records."""

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
    tenant_name = os.environ.get("DEV_TENANT_NAME", "Or-On Workspace").strip()
    if not password_hash or not password_hash.startswith("$argon2id$"):
        raise RuntimeError("DEV_AUTH_PASSWORD_HASH must be a generated Argon2id hash")
    if len(tenant_name) < 2 or len(tenant_name) > 120:
        raise RuntimeError("DEV_TENANT_NAME must contain between 2 and 120 characters")
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
            await connection.execute(statement, {"key": "foundation_version", "value": "phase-7"})
            tenant_id = UUID("10000000-0000-4000-8000-000000000001")
            user_id = UUID("20000000-0000-4000-8000-000000000001")
            await connection.execute(
                text(
                    """
                    INSERT INTO tenants (id, name, slug, status)
                    VALUES (:tenant_id, :tenant_name, 'or-on-workspace', 'active')
                    ON CONFLICT (id) DO UPDATE
                    SET status = 'active', updated_at = CURRENT_TIMESTAMP
                    """
                ),
                {"tenant_id": tenant_id, "tenant_name": tenant_name},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO users (id, email, display_name, is_superuser, status)
                    VALUES (:user_id, :email, 'Platform Administrator', true, 'active')
                    ON CONFLICT (id) DO UPDATE
                    SET is_superuser = true, status = 'active',
                        updated_at = CURRENT_TIMESTAMP
                    """
                ),
                {"user_id": user_id, "email": email},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO memberships (user_id, tenant_id, role)
                    VALUES (:user_id, :tenant_id, 'owner')
                    ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role
                    """
                ),
                {"user_id": user_id, "tenant_id": tenant_id},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO crm.tenant_settings(
                        tenant_id, display_name, default_currency, locale, timezone
                    )
                    VALUES (:tenant_id, :tenant_name, 'USD', 'en', 'UTC')
                    ON CONFLICT (tenant_id) DO NOTHING
                    """
                ),
                {"tenant_id": tenant_id, "tenant_name": tenant_name},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO billing.wallets (tenant_id, currency)
                    VALUES (:tenant_id, 'USD')
                    ON CONFLICT (tenant_id) DO NOTHING
                    """
                ),
                {"tenant_id": tenant_id},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO platform.auth_credentials (user_id, password_hash)
                    VALUES (:user_id, :password_hash)
                    ON CONFLICT (user_id) DO NOTHING
                    """
                ),
                {"user_id": user_id, "password_hash": password_hash},
            )
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed())
