"""Idempotent, fictional development seed for implemented platform surfaces."""

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
                {"key": "foundation_version", "value": "phase-4"},
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
            await connection.execute(
                text(
                    """
                    INSERT INTO crm.tags (id, tenant_id, name, color)
                    VALUES ('31000000-0000-4000-8000-000000000001', :tenant, 'Priority', '#7c9cff'),
                           ('31000000-0000-4000-8000-000000000002', :tenant, 'Demo', '#4fd1a8')
                    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color
                    """
                ),
                {"tenant": primary_tenant},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO crm.contacts
                      (id, tenant_id, created_by_user_id, assigned_user_id, name,
                       email, company, last_activity_at)
                    VALUES ('30000000-0000-4000-8000-000000000001', :tenant,
                            :user_id, :user_id, 'Maya Cohen',
                            'maya@example.invalid', 'Lumen Works', CURRENT_TIMESTAMP)
                    ON CONFLICT (id) DO UPDATE
                    SET name = EXCLUDED.name, email = EXCLUDED.email,
                        company = EXCLUDED.company, lifecycle_status = 'active'
                    """
                ),
                {"tenant": primary_tenant, "user_id": user_id},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO crm.custom_field_definitions
                      (id, tenant_id, key, label, field_type)
                    VALUES ('33000000-0000-4000-8000-000000000001', :tenant,
                            'customer_tier', 'Customer tier', 'text')
                    ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label
                    """
                ),
                {"tenant": primary_tenant},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO crm.contact_channel_identities
                      (id, tenant_id, contact_id, channel, normalized_value,
                       display_value, provider, provider_identity_id,
                       validation_status, is_primary)
                    VALUES ('32000000-0000-4000-8000-000000000001', :tenant,
                            '30000000-0000-4000-8000-000000000001', 'whatsapp',
                            '+972501234567', '+972 50 123 4567', 'simulator',
                            '+972501234567', 'valid', true)
                    ON CONFLICT (tenant_id, channel, normalized_value)
                      WHERE normalized_value IS NOT NULL
                    DO UPDATE SET display_value = EXCLUDED.display_value,
                                  validation_status = 'valid', is_primary = true
                    """
                ),
                {"tenant": primary_tenant},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO crm.contact_tags (tenant_id, contact_id, tag_id)
                    VALUES (:tenant, '30000000-0000-4000-8000-000000000001',
                            '31000000-0000-4000-8000-000000000001'),
                           (:tenant, '30000000-0000-4000-8000-000000000001',
                            '31000000-0000-4000-8000-000000000002')
                    ON CONFLICT DO NOTHING
                    """
                ),
                {"tenant": primary_tenant},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO crm.pipelines (id, tenant_id, name, is_default)
                    VALUES ('40000000-0000-4000-8000-000000000001', :tenant,
                            'Customer journey', true)
                    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, is_default = true
                    """
                ),
                {"tenant": primary_tenant},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO crm.pipeline_stages
                      (id, tenant_id, pipeline_id, name, position, probability)
                    VALUES ('41000000-0000-4000-8000-000000000001', :tenant,
                            '40000000-0000-4000-8000-000000000001', 'New', 0, 20),
                           ('41000000-0000-4000-8000-000000000002', :tenant,
                            '40000000-0000-4000-8000-000000000001', 'Qualified', 1, 60),
                           ('41000000-0000-4000-8000-000000000003', :tenant,
                            '40000000-0000-4000-8000-000000000001', 'Won', 2, 100)
                    ON CONFLICT (id) DO UPDATE
                    SET name = EXCLUDED.name, position = EXCLUDED.position,
                        probability = EXCLUDED.probability
                    """
                ),
                {"tenant": primary_tenant},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO crm.deals
                      (id, tenant_id, pipeline_id, stage_id, contact_id,
                       owner_user_id, title, value, currency, status)
                    VALUES ('42000000-0000-4000-8000-000000000001', :tenant,
                            '40000000-0000-4000-8000-000000000001',
                            '41000000-0000-4000-8000-000000000002',
                            '30000000-0000-4000-8000-000000000001', :user_id,
                            'Fictional engagement pilot', 12500, 'USD', 'open')
                    ON CONFLICT (id) DO UPDATE
                    SET stage_id = EXCLUDED.stage_id, title = EXCLUDED.title,
                        value = EXCLUDED.value, status = 'open'
                    """
                ),
                {"tenant": primary_tenant, "user_id": user_id},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO messaging.channels
                      (id, tenant_id, kind, provider, provider_account_id,
                       display_address, status, configuration)
                    VALUES ('50000000-0000-4000-8000-000000000001',
                            CAST(:tenant AS uuid),
                            'whatsapp', 'simulator',
                            'simulator:' || CAST(:tenant AS text),
                            'WhatsApp simulator', 'active', '{"mode":"simulator"}'::jsonb)
                    ON CONFLICT (provider, provider_account_id)
                      WHERE provider_account_id IS NOT NULL
                    DO UPDATE SET status = 'active', updated_at = CURRENT_TIMESTAMP
                    """
                ),
                {"tenant": primary_tenant},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO messaging.conversations
                      (id, tenant_id, channel_id, contact_id, assigned_user_id,
                       status, unread_count, last_message_at, last_message_preview)
                    VALUES ('51000000-0000-4000-8000-000000000001', :tenant,
                            '50000000-0000-4000-8000-000000000001',
                            '30000000-0000-4000-8000-000000000001', :user_id,
                            'open', 1, CURRENT_TIMESTAMP,
                            'Can the simulator show our shared inbox?')
                    ON CONFLICT (tenant_id, channel_id, contact_id)
                    DO UPDATE SET assigned_user_id = EXCLUDED.assigned_user_id,
                                  status = 'open'
                    """
                ),
                {"tenant": primary_tenant, "user_id": user_id},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO messaging.quick_replies
                      (id, tenant_id, title, body, shortcut, created_by_user_id)
                    VALUES ('53000000-0000-4000-8000-000000000001', :tenant,
                            'Warm greeting', 'Thanks for reaching out — how can we help?',
                            '/hello', :user_id)
                    ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title,
                                                   body = EXCLUDED.body
                    """
                ),
                {"tenant": primary_tenant, "user_id": user_id},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO messaging.messages
                      (id, tenant_id, conversation_id, direction, sender_type,
                       sender_contact_id, content_type, content_text, provider,
                       provider_message_id, status, provider_payload)
                    VALUES ('52000000-0000-4000-8000-000000000001', :tenant,
                            '51000000-0000-4000-8000-000000000001', 'inbound',
                            'contact', '30000000-0000-4000-8000-000000000001',
                            'text', 'Can the simulator show our shared inbox?',
                            'simulator', 'sim_seed_message_001', 'received',
                            CAST(:provider_payload AS jsonb))
                    ON CONFLICT (tenant_id, provider, provider_message_id)
                      WHERE provider IS NOT NULL AND provider_message_id IS NOT NULL
                    DO NOTHING
                    """
                ),
                {"tenant": primary_tenant, "provider_payload": '{"fictional":true}'},
            )
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed())
