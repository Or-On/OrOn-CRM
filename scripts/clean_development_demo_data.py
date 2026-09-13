"""Safely retire exact development fixtures and repository-test residue.

The command is a dry run unless ``--apply`` is supplied. Even with that flag,
it only connects to a loopback PostgreSQL database named
``or_on_platform_dev``. It removes only deterministic seed identities,
source-marked simulator descendants, or exact repository-test tenants; any
customized identity, real-provider marker, or unknown relationship fails closed.
"""

from __future__ import annotations

import argparse
import asyncio
import os
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote, urlsplit
from uuid import UUID

from dotenv import load_dotenv
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

DEVELOPMENT_DATABASE_NAME = "or_on_platform_dev"
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})

PRIMARY_TENANT = UUID("10000000-0000-4000-8000-000000000001")
SECONDARY_DEMO_TENANT = UUID("10000000-0000-4000-8000-000000000002")
PRIMARY_USER = UUID("20000000-0000-4000-8000-000000000001")
DEMO_CONTACT = UUID("30000000-0000-4000-8000-000000000001")
DEMO_CHANNEL = UUID("50000000-0000-4000-8000-000000000001")
DEMO_VOICE_FLOW = UUID("11111111-1111-4111-8111-111111111111")
DEMO_VOICE_FLOW_VERSION = 1

# Fingerprints identify the exact locally published ``Fictional welcome``
# document without embedding its prompts or generated specification here.
DEMO_VOICE_FLOW_SOURCE_FINGERPRINT = "c4fa73d612d2570e23e2a1056e57ed7c"
DEMO_VOICE_FLOW_SPEC_FINGERPRINT = "a6d2206a0feb6f04c28e1192fc4c92e4"

PRIMARY_SEED_IDENTITY = ("Aurora Operations", "aurora-operations")
PRIMARY_PRODUCT_IDENTITY = ("Or-On Workspace", "or-on-workspace")

TEST_TENANT_TABLES: dict[str, frozenset[tuple[str, str]]] = {
    "Default": frozenset(),
    "Importer tenant": frozenset(
        {
            ("public", "memberships"),
            ("live", "chats"),
            ("live", "messages"),
            ("live", "provider_configurations"),
            ("live", "user_preferences"),
            ("live", "voice_profiles"),
            ("ops", "import_items"),
            ("ops", "import_runs"),
        }
    ),
    "SQLite importer tenant": frozenset(
        {
            ("public", "memberships"),
            ("live", "chats"),
            ("live", "messages"),
            ("ops", "import_items"),
            ("ops", "import_runs"),
        }
    ),
    "Phase 4 API": frozenset({("public", "api_keys"), ("public", "memberships")}),
    "Other API tenant": frozenset(),
}

TEST_TENANT_DELETE_ORDER = (
    ("live", "messages"),
    ("live", "provider_configurations"),
    ("live", "user_preferences"),
    ("live", "voice_profiles"),
    ("live", "chats"),
    ("ops", "import_items"),
    ("ops", "import_runs"),
    ("public", "api_keys"),
    ("public", "memberships"),
)

TEST_ROW_KEYS: dict[tuple[str, str], tuple[str, ...]] = {
    ("public", "memberships"): ("tenant_id", "user_id"),
    ("live", "user_preferences"): ("tenant_id", "user_id", "key"),
    ("ops", "import_items"): (
        "tenant_id",
        "import_run_id",
        "source_kind",
        "source_id",
    ),
}


def known_fixture_rows() -> dict[tuple[str, str], tuple[dict[str, Any], ...]]:
    """Exact old-seed rows, used to distinguish fixture-to-fixture references."""

    return {
        ("crm", "tags"): (
            {
                "id": UUID("31000000-0000-4000-8000-000000000001"),
                "tenant_id": PRIMARY_TENANT,
            },
            {
                "id": UUID("31000000-0000-4000-8000-000000000002"),
                "tenant_id": PRIMARY_TENANT,
            },
        ),
        ("crm", "contacts"): (
            {
                "id": UUID("30000000-0000-4000-8000-000000000001"),
                "tenant_id": PRIMARY_TENANT,
            },
        ),
        ("crm", "custom_field_definitions"): (
            {
                "id": UUID("33000000-0000-4000-8000-000000000001"),
                "tenant_id": PRIMARY_TENANT,
            },
        ),
        ("crm", "contact_channel_identities"): (
            {
                "id": UUID("32000000-0000-4000-8000-000000000001"),
                "tenant_id": PRIMARY_TENANT,
            },
        ),
        ("crm", "contact_tags"): (
            {
                "tenant_id": PRIMARY_TENANT,
                "contact_id": UUID("30000000-0000-4000-8000-000000000001"),
                "tag_id": UUID("31000000-0000-4000-8000-000000000001"),
            },
            {
                "tenant_id": PRIMARY_TENANT,
                "contact_id": UUID("30000000-0000-4000-8000-000000000001"),
                "tag_id": UUID("31000000-0000-4000-8000-000000000002"),
            },
        ),
        ("crm", "pipelines"): (
            {
                "id": UUID("40000000-0000-4000-8000-000000000001"),
                "tenant_id": PRIMARY_TENANT,
            },
        ),
        ("crm", "pipeline_stages"): tuple(
            {
                "id": UUID(f"41000000-0000-4000-8000-{position:012d}"),
                "tenant_id": PRIMARY_TENANT,
                "pipeline_id": UUID("40000000-0000-4000-8000-000000000001"),
            }
            for position in range(1, 4)
        ),
        ("crm", "deals"): (
            {
                "id": UUID("42000000-0000-4000-8000-000000000001"),
                "tenant_id": PRIMARY_TENANT,
            },
        ),
        ("messaging", "channels"): (
            {
                "id": UUID("50000000-0000-4000-8000-000000000001"),
                "tenant_id": PRIMARY_TENANT,
            },
        ),
        ("messaging", "conversations"): (
            {
                "id": UUID("51000000-0000-4000-8000-000000000001"),
                "tenant_id": PRIMARY_TENANT,
            },
        ),
        ("messaging", "messages"): (
            {
                "id": UUID("52000000-0000-4000-8000-000000000001"),
                "tenant_id": PRIMARY_TENANT,
            },
        ),
        ("messaging", "quick_replies"): (
            {
                "id": UUID("53000000-0000-4000-8000-000000000001"),
                "tenant_id": PRIMARY_TENANT,
            },
        ),
    }


@dataclass(frozen=True)
class CleanupTarget:
    """One exact fixture selection and its matching deletion."""

    label: str
    count_sql: str
    delete_sql: str
    parameters: dict[str, Any]
    operation: str = "delete"


@dataclass(frozen=True)
class DiscoveredCleanup:
    """Validated dynamic fixture rows and child-first cleanup operations."""

    rows: dict[tuple[str, str], tuple[dict[str, Any], ...]]
    targets: tuple[CleanupTarget, ...]


def _target(
    label: str,
    table: str,
    *,
    record_id: UUID,
    tenant_id: UUID = PRIMARY_TENANT,
) -> CleanupTarget:
    where = "tenant_id = :tenant_id AND id = :record_id"
    parameters = {"tenant_id": tenant_id, "record_id": record_id}
    return CleanupTarget(
        label=label,
        count_sql=f"SELECT count(*) FROM {table} WHERE {where}",  # noqa: S608
        delete_sql=f"DELETE FROM {table} WHERE {where}",  # noqa: S608
        parameters=parameters,
    )


def _exact_rows_target(
    label: str,
    table: str,
    rows: Sequence[dict[str, Any]],
    *,
    key_columns: Sequence[str] = ("tenant_id", "id"),
) -> CleanupTarget:
    """Build a bound target that can affect only the supplied exact row keys."""

    parameters: dict[str, Any] = {}
    row_terms: list[str] = []
    for row_position, row in enumerate(rows):
        terms: list[str] = []
        for column_position, column in enumerate(key_columns):
            if column not in row:
                raise RuntimeError(f"cleanup row for {table} lacks key column {column}")
            parameter = f"row_{row_position}_{column_position}"
            parameters[parameter] = row[column]
            terms.append(f"{_quote_identifier(column)} = :{parameter}")
        row_terms.append("(" + " AND ".join(terms) + ")")
    where = " OR ".join(row_terms) if row_terms else "FALSE"
    return CleanupTarget(
        label=label,
        count_sql=f"SELECT count(*) FROM {table} WHERE {where}",  # noqa: S608
        delete_sql=f"DELETE FROM {table} WHERE {where}",  # noqa: S608
        parameters=parameters,
    )


def _tenant_rows_target(
    label: str,
    schema_name: str,
    table_name: str,
    tenant_ids: Sequence[UUID],
) -> CleanupTarget:
    """Build an exact tenant-scoped target for already validated test tenants."""

    rows = tuple({"tenant_id": tenant_id} for tenant_id in tenant_ids)
    qualified = f"{_quote_identifier(schema_name)}.{_quote_identifier(table_name)}"
    return _exact_rows_target(label, qualified, rows, key_columns=("tenant_id",))


def _merge_fixture_rows(
    *collections: dict[tuple[str, str], tuple[dict[str, Any], ...]],
) -> dict[tuple[str, str], tuple[dict[str, Any], ...]]:
    """Merge fixture maps while removing duplicate row descriptions."""

    merged: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for collection in collections:
        for table, rows in collection.items():
            bucket = merged.setdefault(table, [])
            for row in rows:
                if row not in bucket:
                    bucket.append(row)
    return {table: tuple(rows) for table, rows in merged.items()}


def cleanup_targets() -> tuple[CleanupTarget, ...]:
    """Return child-first selections for only the retired deterministic fixtures."""

    tag_parameters = {
        "tenant_id": PRIMARY_TENANT,
        "tag_1": UUID("31000000-0000-4000-8000-000000000001"),
        "tag_2": UUID("31000000-0000-4000-8000-000000000002"),
    }
    stage_parameters = {
        "tenant_id": PRIMARY_TENANT,
        "stage_1": UUID("41000000-0000-4000-8000-000000000001"),
        "stage_2": UUID("41000000-0000-4000-8000-000000000002"),
        "stage_3": UUID("41000000-0000-4000-8000-000000000003"),
    }
    contact_tag_where = (
        "tenant_id = :tenant_id "
        "AND contact_id = '30000000-0000-4000-8000-000000000001'::uuid "
        "AND tag_id IN (:tag_1, :tag_2)"
    )
    tag_where = "tenant_id = :tenant_id AND id IN (:tag_1, :tag_2)"
    stage_where = "tenant_id = :tenant_id AND id IN (:stage_1, :stage_2, :stage_3)"
    membership_parameters = {
        "tenant_id": SECONDARY_DEMO_TENANT,
        "user_id": PRIMARY_USER,
    }
    membership_where = "tenant_id = :tenant_id AND user_id = :user_id AND role = 'admin'"
    tenant_parameters = {"tenant_id": SECONDARY_DEMO_TENANT}
    tenant_where = "id = :tenant_id AND slug = 'northstar-studio' AND name = 'Northstar Studio'"
    secondary_audit_where = (
        "tenant_id = :tenant_id "
        "AND actor_user_id = :user_id "
        "AND actor_service IS NULL "
        "AND action IN ('auth.tenant.switched', 'auth.session.revoked') "
        "AND target_type = 'auth_session' "
        "AND request_id IS NOT NULL"
    )

    return (
        _target(
            "demo_channel",
            "messaging.channels",
            record_id=UUID("50000000-0000-4000-8000-000000000001"),
        ),
        _target(
            "demo_deal",
            "crm.deals",
            record_id=UUID("42000000-0000-4000-8000-000000000001"),
        ),
        CleanupTarget(
            "demo_contact_tags",
            f"SELECT count(*) FROM crm.contact_tags WHERE {contact_tag_where}",  # noqa: S608
            f"DELETE FROM crm.contact_tags WHERE {contact_tag_where}",  # noqa: S608
            tag_parameters,
        ),
        _target(
            "demo_contact_identity",
            "crm.contact_channel_identities",
            record_id=UUID("32000000-0000-4000-8000-000000000001"),
        ),
        _target(
            "demo_contact",
            "crm.contacts",
            record_id=UUID("30000000-0000-4000-8000-000000000001"),
        ),
        CleanupTarget(
            "demo_pipeline_stages",
            f"SELECT count(*) FROM crm.pipeline_stages WHERE {stage_where}",  # noqa: S608
            f"DELETE FROM crm.pipeline_stages WHERE {stage_where}",  # noqa: S608
            stage_parameters,
        ),
        _target(
            "demo_pipeline",
            "crm.pipelines",
            record_id=UUID("40000000-0000-4000-8000-000000000001"),
        ),
        _target(
            "demo_custom_field",
            "crm.custom_field_definitions",
            record_id=UUID("33000000-0000-4000-8000-000000000001"),
        ),
        _target(
            "demo_quick_reply",
            "messaging.quick_replies",
            record_id=UUID("53000000-0000-4000-8000-000000000001"),
        ),
        CleanupTarget(
            "demo_tags",
            f"SELECT count(*) FROM crm.tags WHERE {tag_where}",  # noqa: S608
            f"DELETE FROM crm.tags WHERE {tag_where}",  # noqa: S608
            tag_parameters,
        ),
        CleanupTarget(
            "secondary_demo_auth_audit",
            f"SELECT count(*) FROM audit.records WHERE {secondary_audit_where}",  # noqa: S608
            f"DELETE FROM audit.records WHERE {secondary_audit_where}",  # noqa: S608
            membership_parameters,
        ),
        CleanupTarget(
            "secondary_demo_membership",
            f"SELECT count(*) FROM memberships WHERE {membership_where}",  # noqa: S608
            f"DELETE FROM memberships WHERE {membership_where}",  # noqa: S608
            membership_parameters,
        ),
        CleanupTarget(
            "secondary_demo_tenant",
            f"SELECT count(*) FROM tenants WHERE {tenant_where}",  # noqa: S608
            f"DELETE FROM tenants WHERE {tenant_where}",  # noqa: S608
            tenant_parameters,
        ),
    )


def guarded_database_url(value: str | None) -> str:
    """Return an asyncpg URL only for the exact owned local development DB."""

    if not value:
        raise RuntimeError("MIGRATION_DATABASE_URL is required")
    parsed = urlsplit(value)
    if parsed.scheme not in {"postgresql", "postgresql+asyncpg"}:
        raise RuntimeError("cleanup requires PostgreSQL; no other database is accepted")
    if (parsed.hostname or "").lower() not in LOOPBACK_HOSTS:
        raise RuntimeError("cleanup refuses non-loopback PostgreSQL hosts")
    database_name = unquote(parsed.path.removeprefix("/"))
    if database_name != DEVELOPMENT_DATABASE_NAME:
        raise RuntimeError(
            f"cleanup requires the exact development database name {DEVELOPMENT_DATABASE_NAME!r}"
        )
    return value.replace("postgresql://", "postgresql+asyncpg://", 1)


def _quote_identifier(value: str) -> str:
    """Quote a PostgreSQL identifier discovered from the system catalog."""

    return '"' + value.replace('"', '""') + '"'


async def _validated_key_rows(
    connection: AsyncConnection,
    *,
    label: str,
    statement: str,
    parameters: dict[str, Any],
) -> tuple[dict[str, Any], ...]:
    """Return identifiers only when every candidate passes its SQL classifier."""

    rows = tuple((await connection.execute(text(statement), parameters)).mappings())
    unsafe = sum(1 for row in rows if row.get("safe") is not True)
    if unsafe:
        raise RuntimeError(
            f"refusing cleanup: {label} contains {unsafe} row(s) "
            "without exact test/simulator markers"
        )
    return tuple(
        {str(key): value for key, value in row.items() if str(key) != "safe"} for row in rows
    )


async def _validate_primary_fixture_identities(connection: AsyncConnection) -> None:
    """Refuse deterministic IDs whose original source identity was customized."""

    parameters = {
        "tenant_id": PRIMARY_TENANT,
        "user_id": PRIMARY_USER,
        "contact_id": UUID("30000000-0000-4000-8000-000000000001"),
        "identity_id": UUID("32000000-0000-4000-8000-000000000001"),
        "channel_id": UUID("50000000-0000-4000-8000-000000000001"),
    }
    checks = {
        "deterministic demo contact": """
            SELECT id, tenant_id,
                   name = 'Maya Cohen'
                   AND email = 'maya@example.invalid'
                   AND company = 'Lumen Works'
                   AND created_by_user_id = :user_id
                   AND assigned_user_id = :user_id AS safe
            FROM crm.contacts
            WHERE tenant_id = :tenant_id AND id = :contact_id
        """,
        "deterministic demo contact identity": """
            SELECT id, tenant_id,
                   contact_id = :contact_id
                   AND channel = 'whatsapp'
                   AND normalized_value = '+972501234567'
                   AND display_value = '+972 50 123 4567'
                   AND provider = 'simulator'
                   AND provider_identity_id = '+972501234567'
                   AND validation_status = 'valid'
                   AND is_primary AS safe
            FROM crm.contact_channel_identities
            WHERE tenant_id = :tenant_id AND id = :identity_id
        """,
        "deterministic simulator channel": """
            SELECT id, tenant_id,
                   kind = 'whatsapp'
                   AND provider = 'simulator'
                   AND provider_account_id = 'simulator:' || tenant_id::text
                   AND display_address = 'WhatsApp simulator'
                   AND status = 'active'
                   AND configuration = jsonb_build_object('mode', 'simulator') AS safe
            FROM messaging.channels
            WHERE tenant_id = :tenant_id AND id = :channel_id
        """,
        "deterministic demo tags": """
            SELECT id, tenant_id,
                   (id = '31000000-0000-4000-8000-000000000001'::uuid
                    AND name = 'Priority' AND color = '#7c9cff')
                   OR
                   (id = '31000000-0000-4000-8000-000000000002'::uuid
                    AND name = 'Demo' AND color = '#4fd1a8') AS safe
            FROM crm.tags
            WHERE tenant_id = :tenant_id
              AND id IN (
                '31000000-0000-4000-8000-000000000001'::uuid,
                '31000000-0000-4000-8000-000000000002'::uuid
              )
        """,
        "deterministic demo custom field": """
            SELECT id, tenant_id,
                   key = 'customer_tier'
                   AND label = 'Customer tier'
                   AND field_type = 'text' AS safe
            FROM crm.custom_field_definitions
            WHERE tenant_id = :tenant_id
              AND id = '33000000-0000-4000-8000-000000000001'::uuid
        """,
        "deterministic demo pipeline": """
            SELECT id, tenant_id,
                   name = 'Customer journey' AND is_default AS safe
            FROM crm.pipelines
            WHERE tenant_id = :tenant_id
              AND id = '40000000-0000-4000-8000-000000000001'::uuid
        """,
        "deterministic demo pipeline stages": """
            SELECT id, tenant_id,
                   pipeline_id = '40000000-0000-4000-8000-000000000001'::uuid
                   AND (
                     (id = '41000000-0000-4000-8000-000000000001'::uuid
                      AND name = 'New' AND position = 0 AND probability = 20)
                     OR
                     (id = '41000000-0000-4000-8000-000000000002'::uuid
                      AND name = 'Qualified' AND position = 1 AND probability = 60)
                     OR
                     (id = '41000000-0000-4000-8000-000000000003'::uuid
                      AND name = 'Won' AND position = 2 AND probability = 100)
                   ) AS safe
            FROM crm.pipeline_stages
            WHERE tenant_id = :tenant_id
              AND id IN (
                '41000000-0000-4000-8000-000000000001'::uuid,
                '41000000-0000-4000-8000-000000000002'::uuid,
                '41000000-0000-4000-8000-000000000003'::uuid
              )
        """,
        "deterministic demo deal": """
            SELECT id, tenant_id,
                   pipeline_id = '40000000-0000-4000-8000-000000000001'::uuid
                   AND stage_id = '41000000-0000-4000-8000-000000000002'::uuid
                   AND contact_id = :contact_id
                   AND owner_user_id = :user_id
                   AND title = 'Fictional engagement pilot'
                   AND value = 12500
                   AND currency = 'USD'
                   AND status = 'open' AS safe
            FROM crm.deals
            WHERE tenant_id = :tenant_id
              AND id = '42000000-0000-4000-8000-000000000001'::uuid
        """,
        "deterministic demo quick reply": """
            SELECT id, tenant_id,
                   title = 'Warm greeting'
                   AND body = 'Thanks for reaching out — how can we help?'
                   AND shortcut = '/hello'
                   AND created_by_user_id = :user_id AS safe
            FROM messaging.quick_replies
            WHERE tenant_id = :tenant_id
              AND id = '53000000-0000-4000-8000-000000000001'::uuid
        """,
    }
    for label, statement in checks.items():
        await _validated_key_rows(
            connection,
            label=label,
            statement=statement,
            parameters=parameters,
        )


async def _discover_simulator_dependents(connection: AsyncConnection) -> DiscoveredCleanup:
    """Classify exact simulator descendants without reading bodies or phone values."""

    await _validate_primary_fixture_identities(connection)
    parameters = {
        "tenant_id": PRIMARY_TENANT,
        "contact_id": UUID("30000000-0000-4000-8000-000000000001"),
        "channel_id": UUID("50000000-0000-4000-8000-000000000001"),
        "seed_message_id": UUID("52000000-0000-4000-8000-000000000001"),
    }
    conversation_rows = await _validated_key_rows(
        connection,
        label="simulator conversations",
        statement="""
            SELECT id, tenant_id, TRUE AS safe
            FROM messaging.conversations
            WHERE tenant_id = :tenant_id AND channel_id = :channel_id
        """,
        parameters=parameters,
    )
    message_rows = await _validated_key_rows(
        connection,
        label="simulator messages",
        statement="""
            SELECT message.id, message.tenant_id,
                   message.provider = 'simulator'
                   AND message.provider_message_id IS NOT NULL
                   AND message.provider_message_id !~* '(wamid|meta)'
                   AND message.object_id IS NULL
                   AND (
                     (message.id = :seed_message_id
                      AND message.direction = 'inbound'
                      AND message.sender_type = 'contact'
                      AND message.content_type = 'text'
                      AND message.status = 'received'
                      AND message.provider_payload = jsonb_build_object('fictional', true))
                     OR
                     (message.direction = 'inbound'
                      AND message.sender_type = 'contact'
                      AND message.content_type = 'text'
                      AND message.status = 'received'
                      AND message.provider_payload->>'source' = 'whatsapp_simulator'
                      AND NULLIF(message.provider_payload->>'providerEventId', '') IS NOT NULL
                      AND COALESCE(message.provider_payload->>'providerEventId', '')
                          !~* '(wamid|meta)'
                      AND message.provider_payload - 'source' - 'providerEventId' = '{}'::jsonb)
                     OR
                     (message.direction = 'outbound'
                      AND message.content_type = 'text'
                      AND message.status = 'delivered'
                      AND message.provider_payload->>'simulator' = 'true'
                      AND (
                        (NULLIF(message.provider_payload->>'deliveryId', '') IS NOT NULL
                         AND COALESCE(message.provider_payload->>'deliveryId', '')
                             !~* '(wamid|meta)'
                         AND message.provider_payload - 'simulator' - 'deliveryId' = '{}'::jsonb)
                        OR (message.provider_message_id LIKE 'sim_call_followup_%'
                            AND message.provider_payload ? 'jobId'
                            AND message.provider_payload ? 'sessionId'
                            AND message.provider_payload - 'simulator' - 'jobId' - 'sessionId'
                                = '{}'::jsonb)
                      ))
                   ) AS safe
            FROM messaging.messages message
            JOIN messaging.conversations conversation
              ON (conversation.tenant_id, conversation.id) =
                 (message.tenant_id, message.conversation_id)
            WHERE conversation.tenant_id = :tenant_id
              AND conversation.channel_id = :channel_id
        """,
        parameters=parameters,
    )
    delivery_rows = await _validated_key_rows(
        connection,
        label="simulator message delivery events",
        statement="""
            SELECT delivery.id, delivery.tenant_id,
                   delivery.provider_event_id IS NOT NULL
                   AND delivery.provider_event_id !~* '(wamid|meta)'
                   AND (delivery.provider_event_id LIKE 'sim_status_%'
                        OR delivery.provider_event_id LIKE 'simulator_accepted_%')
                   AND delivery.payload IS NULL AS safe
            FROM messaging.message_delivery_events delivery
            JOIN messaging.messages message
              ON (message.tenant_id, message.id) =
                 (delivery.tenant_id, delivery.message_id)
            JOIN messaging.conversations conversation
              ON (conversation.tenant_id, conversation.id) =
                 (message.tenant_id, message.conversation_id)
            WHERE conversation.tenant_id = :tenant_id
              AND conversation.channel_id = :channel_id
        """,
        parameters=parameters,
    )
    reaction_rows = await _validated_key_rows(
        connection,
        label="simulator message reactions",
        statement="""
            SELECT reaction.id, reaction.tenant_id, TRUE AS safe
            FROM messaging.message_reactions reaction
            JOIN messaging.messages message
              ON (message.tenant_id, message.id) =
                 (reaction.tenant_id, reaction.message_id)
            JOIN messaging.conversations conversation
              ON (conversation.tenant_id, conversation.id) =
                 (message.tenant_id, message.conversation_id)
            WHERE conversation.tenant_id = :tenant_id
              AND conversation.channel_id = :channel_id
        """,
        parameters=parameters,
    )
    participant_rows = await _validated_key_rows(
        connection,
        label="simulator conversation participants",
        statement="""
            SELECT participant.conversation_id, participant.tenant_id,
                   participant.participant_type IN ('contact', 'user', 'service') AS safe
            FROM messaging.conversation_participants participant
            JOIN messaging.conversations conversation
              ON (conversation.tenant_id, conversation.id) =
                 (participant.tenant_id, participant.conversation_id)
            WHERE conversation.tenant_id = :tenant_id
              AND conversation.channel_id = :channel_id
        """,
        parameters=parameters,
    )
    outbound_rows = await _validated_key_rows(
        connection,
        label="simulator outbound requests",
        statement="""
            SELECT request.id, request.tenant_id,
                   request.provider = 'simulator'
                   AND NOT request.explicitly_confirmed
                   AND (request.provider_message_id IS NULL
                        OR request.provider_message_id !~* '(wamid|meta)') AS safe
            FROM messaging.outbound_requests request
            WHERE request.tenant_id = :tenant_id
              AND request.channel_id = :channel_id
        """,
        parameters=parameters,
    )
    template_rows = await _validated_key_rows(
        connection,
        label="simulator message templates",
        statement="""
            SELECT template.id, template.tenant_id,
                   template.name ~
                     '^sim-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                   AND template.language = 'en'
                   AND template.category = 'MARKETING'
                   AND template.status = 'approved'
                   AND template.components IS NULL
                   AND template.provider_template_id IS NULL AS safe
            FROM messaging.message_templates template
            WHERE template.tenant_id = :tenant_id
              AND template.channel_id = :channel_id
        """,
        parameters=parameters,
    )
    campaign_rows = await _validated_key_rows(
        connection,
        label="simulator campaign records",
        statement="""
            SELECT DISTINCT campaign.id, campaign.tenant_id,
                   campaign.channel = 'whatsapp'
                   AND campaign.status = 'draft'
                   AND campaign.created_by_user_id IS NOT NULL AS safe
            FROM platform.campaigns campaign
            JOIN messaging.message_templates template
              ON template.tenant_id = campaign.tenant_id
             AND template.name = 'sim-' || campaign.id::text
            WHERE template.tenant_id = :tenant_id
              AND template.channel_id = :channel_id
        """,
        parameters=parameters,
    )
    broadcast_rows = await _validated_key_rows(
        connection,
        label="simulator broadcasts",
        statement="""
            SELECT broadcast.id, broadcast.tenant_id,
                   template.name = 'sim-' || campaign.id::text
                   AND template.provider_template_id IS NULL
                   AND campaign.channel = 'whatsapp'
                   AND broadcast.status IN
                     ('draft', 'scheduled', 'sending', 'paused', 'sent', 'failed', 'cancelled')
                   AS safe
            FROM messaging.broadcasts broadcast
            JOIN messaging.message_templates template
              ON (template.tenant_id, template.id) =
                 (broadcast.tenant_id, broadcast.template_id)
            JOIN platform.campaigns campaign
              ON (campaign.tenant_id, campaign.id) =
                 (broadcast.tenant_id, broadcast.campaign_id)
            WHERE broadcast.tenant_id = :tenant_id
              AND broadcast.channel_id = :channel_id
        """,
        parameters=parameters,
    )
    recipient_rows = await _validated_key_rows(
        connection,
        label="simulator broadcast recipients",
        statement="""
            SELECT recipient.id, recipient.tenant_id,
                   recipient.attempts >= 0
                   AND recipient.last_error_safe IS NULL
                   AND (
                     (recipient.status IN ('pending', 'failed')
                      AND recipient.provider_message_id IS NULL)
                     OR
                     (recipient.status IN ('sent', 'delivered', 'read', 'replied')
                      AND recipient.provider_message_id LIKE 'sim_broadcast_%'
                      AND recipient.provider_message_id !~* '(wamid|meta)')
                   ) AS safe
            FROM messaging.broadcast_recipients recipient
            JOIN messaging.broadcasts broadcast
              ON (broadcast.tenant_id, broadcast.id) =
                 (recipient.tenant_id, recipient.broadcast_id)
            WHERE broadcast.tenant_id = :tenant_id
              AND broadcast.channel_id = :channel_id
        """,
        parameters=parameters,
    )
    broadcast_job_rows = await _validated_key_rows(
        connection,
        label="simulator broadcast jobs",
        statement="""
            SELECT job.id, job.tenant_id,
                   job.queue = 'messaging'
                   AND job.job_type = 'simulator.broadcast.recipient'
                   AND job.reference_type = 'broadcast_recipient'
                   AND job.idempotency_key = 'broadcast-recipient:' || job.reference_id::text
                   AND job.payload->>'recipientId' = job.reference_id::text
                   AND job.payload->>'broadcastId' = recipient.broadcast_id::text AS safe
            FROM ops.jobs job
            JOIN messaging.broadcast_recipients recipient
              ON recipient.tenant_id = job.tenant_id
             AND recipient.id = job.reference_id
            JOIN messaging.broadcasts broadcast
              ON broadcast.tenant_id = recipient.tenant_id
             AND broadcast.id = recipient.broadcast_id
            WHERE broadcast.tenant_id = :tenant_id
              AND broadcast.channel_id = :channel_id
        """,
        parameters=parameters,
    )
    session_rows = await _validated_key_rows(
        connection,
        label="simulator voice sessions",
        statement="""
            SELECT session_id, tenant_id,
                   provider = 'simulator'
                   AND provider_call_id = 'simulator:' || session_id::text
                   AND room = 'simulator:' || session_id::text
                   AND direction = 'outbound'
                   AND status IN ('ended', 'failed')
                   AND recording_object_id IS NULL
                   AND transcript_object_id IS NULL AS safe
            FROM sessions
            WHERE tenant_id = :tenant_id AND contact_id = :contact_id
        """,
        parameters=parameters,
    )
    session_event_rows = await _validated_key_rows(
        connection,
        label="simulator voice session events",
        statement="""
            SELECT event.id, event.tenant_id,
                   event.provider = 'simulator'
                   AND event.provider_event_id IS NULL
                   AND event.event_type IN (
                     'voice.call.requested.v1', 'voice.call.started.v1',
                     'voice.call.answered.v1', 'voice.call.transcript.updated.v1',
                     'voice.call.outcome.recorded.v1', 'voice.call.ended.v1'
                   )
                   AND event.payload::text !~* '(wamid|twilio|telnyx|livekit)' AS safe
            FROM session_events event
            JOIN sessions session
              ON (session.tenant_id, session.session_id) =
                 (event.tenant_id, event.session_id)
            WHERE session.tenant_id = :tenant_id
              AND session.contact_id = :contact_id
        """,
        parameters=parameters,
    )
    outbox_rows = await _validated_key_rows(
        connection,
        label="simulator voice outbox events",
        statement="""
            SELECT event.id, event.tenant_id,
                   event.aggregate_type = 'voice_session'
                   AND event.event_type IN (
                     'voice.call.requested.v1', 'voice.call.started.v1',
                     'voice.call.answered.v1', 'voice.call.transcript.updated.v1',
                     'voice.call.outcome.recorded.v1', 'voice.call.ended.v1'
                   )
                   AND event.payload->>'session_id' = event.aggregate_id::text
                   AND event.payload::text !~* '(wamid|twilio|telnyx|livekit)' AS safe
            FROM ops.outbox_events event
            JOIN sessions session
              ON session.tenant_id = event.tenant_id
             AND session.session_id = event.aggregate_id
            WHERE session.tenant_id = :tenant_id
              AND session.contact_id = :contact_id
        """,
        parameters=parameters,
    )
    audit_rows = await _validated_key_rows(
        connection,
        label="simulator voice audit records",
        statement="""
            SELECT record.id, record.tenant_id,
                   record.target_type = 'voice_session'
                   AND record.action = 'voice.simulated_call.completed'
                   AND (record.metadata->>'provider' = 'simulator'
                        OR record.metadata->>'mode' = 'simulator') AS safe
            FROM audit.records record
            JOIN sessions session
              ON session.tenant_id = record.tenant_id
             AND session.session_id = record.target_id
            WHERE session.tenant_id = :tenant_id
              AND session.contact_id = :contact_id
        """,
        parameters=parameters,
    )

    rows = {
        ("messaging", "conversations"): conversation_rows,
        ("messaging", "messages"): message_rows,
        ("messaging", "message_delivery_events"): delivery_rows,
        ("messaging", "message_reactions"): reaction_rows,
        ("messaging", "conversation_participants"): participant_rows,
        ("messaging", "outbound_requests"): outbound_rows,
        ("messaging", "message_templates"): template_rows,
        ("platform", "campaigns"): campaign_rows,
        ("messaging", "broadcasts"): broadcast_rows,
        ("messaging", "broadcast_recipients"): recipient_rows,
        ("ops", "jobs"): broadcast_job_rows,
        ("public", "sessions"): session_rows,
        ("public", "session_events"): session_event_rows,
        ("ops", "outbox_events"): outbox_rows,
        ("audit", "records"): audit_rows,
    }
    targets = (
        _exact_rows_target("simulator_voice_audit_records", "audit.records", audit_rows),
        _exact_rows_target("simulator_voice_outbox_events", "ops.outbox_events", outbox_rows),
        _exact_rows_target("simulator_voice_session_events", "session_events", session_event_rows),
        _exact_rows_target("simulator_broadcast_jobs", "ops.jobs", broadcast_job_rows),
        _exact_rows_target(
            "simulator_message_delivery_events",
            "messaging.message_delivery_events",
            delivery_rows,
        ),
        _exact_rows_target(
            "simulator_message_reactions", "messaging.message_reactions", reaction_rows
        ),
        _exact_rows_target(
            "simulator_outbound_requests", "messaging.outbound_requests", outbound_rows
        ),
        _exact_rows_target("simulator_messages", "messaging.messages", message_rows),
        _exact_rows_target(
            "simulator_conversation_participants",
            "messaging.conversation_participants",
            participant_rows,
            key_columns=("tenant_id", "conversation_id"),
        ),
        _exact_rows_target("simulator_conversations", "messaging.conversations", conversation_rows),
        _exact_rows_target(
            "simulator_broadcast_recipients",
            "messaging.broadcast_recipients",
            recipient_rows,
        ),
        _exact_rows_target("simulator_broadcasts", "messaging.broadcasts", broadcast_rows),
        _exact_rows_target(
            "simulator_message_templates", "messaging.message_templates", template_rows
        ),
        _exact_rows_target("simulator_campaign_records", "platform.campaigns", campaign_rows),
        _exact_rows_target(
            "simulator_voice_sessions",
            "sessions",
            session_rows,
            key_columns=("tenant_id", "session_id"),
        ),
    )
    return DiscoveredCleanup(rows=rows, targets=targets)


async def _discover_primary_voice_artifacts(connection: AsyncConnection) -> DiscoveredCleanup:
    """Find only the exact completed simulator job and deterministic demo flow."""

    parameters = {
        "tenant_id": PRIMARY_TENANT,
        "user_id": PRIMARY_USER,
        "user_id_text": str(PRIMARY_USER),
        "flow_id": DEMO_VOICE_FLOW,
        "flow_id_text": str(DEMO_VOICE_FLOW),
        "flow_version": DEMO_VOICE_FLOW_VERSION,
        "flow_version_text": str(DEMO_VOICE_FLOW_VERSION),
        "source_fingerprint": DEMO_VOICE_FLOW_SOURCE_FINGERPRINT,
        "spec_fingerprint": DEMO_VOICE_FLOW_SPEC_FINGERPRINT,
    }
    voice_job_rows = await _validated_key_rows(
        connection,
        label="primary-tenant completed voice simulator jobs",
        statement="""
            SELECT job.id, job.tenant_id,
                   job.queue = 'voice'
                   AND job.version = 1
                   AND job.reference_type = 'contact'
                   AND job.reference_id IS NOT NULL
                   AND job.idempotency_key ~
                     '^whatsapp-crm-call:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                   AND job.status = 'succeeded'
                   AND job.priority = 0
                   AND job.attempts = 1
                   AND job.max_attempts = 8
                   AND job.locked_at IS NULL
                   AND job.locked_by IS NULL
                   AND job.last_error_safe IS NULL
                   AND job.completed_at IS NOT NULL
                   AND conversation.id IS NOT NULL
                   AND contact.id = job.reference_id
                   AND job.payload = jsonb_build_object(
                     'mode', 'simulator',
                     'contactId', job.reference_id::text,
                     'actorUserId', CAST(:user_id_text AS text),
                     'conversationId', conversation.id::text
                   )
                   AND (
                     SELECT count(*) FROM audit.records record
                     WHERE record.tenant_id = job.tenant_id
                       AND record.target_id = job.id
                   ) = 1
                   AND EXISTS (
                     SELECT 1 FROM audit.records record
                     WHERE record.tenant_id = job.tenant_id
                       AND record.actor_user_id = :user_id
                       AND record.actor_service IS NULL
                       AND record.action = 'simulation.queued'
                       AND record.target_type = 'job'
                       AND record.target_id = job.id
                       AND record.request_id IS NULL
                       AND record.metadata = jsonb_build_object(
                         'mode', 'simulator',
                         'jobType', 'cross_channel.voice_call.simulated'
                       )
                   ) AS safe
            FROM ops.jobs job
            LEFT JOIN messaging.conversations conversation
              ON conversation.tenant_id = job.tenant_id
             AND conversation.id::text = job.payload->>'conversationId'
            LEFT JOIN crm.contacts contact
              ON contact.tenant_id = conversation.tenant_id
             AND contact.id = conversation.contact_id
            WHERE job.tenant_id = :tenant_id
              AND job.job_type = 'cross_channel.voice_call.simulated'
        """,
        parameters=parameters,
    )
    voice_job_audit_rows = await _validated_key_rows(
        connection,
        label="primary-tenant voice simulator queue audit records",
        statement="""
            SELECT record.id, record.tenant_id,
                   record.actor_user_id = :user_id
                   AND record.actor_service IS NULL
                   AND record.target_type = 'job'
                   AND record.request_id IS NULL
                   AND record.metadata = jsonb_build_object(
                     'mode', 'simulator',
                     'jobType', 'cross_channel.voice_call.simulated'
                   )
                   AND EXISTS (
                     SELECT 1 FROM ops.jobs job
                     WHERE job.tenant_id = record.tenant_id
                       AND job.id = record.target_id
                       AND job.queue = 'voice'
                       AND job.job_type = 'cross_channel.voice_call.simulated'
                       AND job.payload->>'mode' = 'simulator'
                   ) AS safe
            FROM audit.records record
            WHERE record.tenant_id = :tenant_id
              AND record.action = 'simulation.queued'
              AND record.metadata->>'jobType' = 'cross_channel.voice_call.simulated'
        """,
        parameters=parameters,
    )
    flow_rows = await _validated_key_rows(
        connection,
        label="deterministic Fictional welcome voice flow",
        statement="""
            SELECT flow.flow_id AS id, flow.flow_id, flow.version, flow.tenant_id,
                   flow.components_version = '4.0.0'
                   AND flow.source->'flow'->>'id' = CAST(:flow_id_text AS text)
                   AND flow.source->'flow'->>'version' = CAST(:flow_version_text AS text)
                   AND flow.source->'flow'->>'name' = 'Fictional welcome'
                   AND flow.source->'flow'->>'language' = 'he'
                   AND md5(flow.source::text) = :source_fingerprint
                   AND md5(flow.spec::text) = :spec_fingerprint
                   AND NOT EXISTS (
                     SELECT 1 FROM flows sibling
                     WHERE sibling.flow_id = flow.flow_id
                       AND sibling.version <> flow.version
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM phone_numbers number
                     WHERE number.flow_id = flow.flow_id
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM sessions session
                     WHERE session.flow_id = flow.flow_id
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM platform.campaigns campaign
                     WHERE campaign.voice_flow_id = flow.flow_id
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM ops.jobs job
                     WHERE job.payload->>'flowId' = flow.flow_id::text
                   )
                   AND (
                     SELECT count(*) FROM audit.records record
                     WHERE record.tenant_id = flow.tenant_id
                       AND record.target_id = flow.flow_id
                   ) = 1
                   AND EXISTS (
                     SELECT 1 FROM audit.records record
                     WHERE record.tenant_id = flow.tenant_id
                       AND record.actor_user_id = :user_id
                       AND record.actor_service IS NULL
                       AND record.action = 'voice.flow.published'
                       AND record.target_type = 'voice_flow'
                       AND record.target_id = flow.flow_id
                       AND record.request_id IS NULL
                       AND record.metadata = jsonb_build_object(
                         'version', CAST(:flow_version AS integer)
                       )
                   ) AS safe
            FROM flows flow
            WHERE flow.flow_id = :flow_id
              AND flow.version = CAST(:flow_version AS integer)
              AND flow.tenant_id = :tenant_id
        """,
        parameters=parameters,
    )
    flow_audit_rows = await _validated_key_rows(
        connection,
        label="deterministic Fictional welcome publication audit record",
        statement="""
            SELECT record.id, record.tenant_id,
                   record.actor_user_id = :user_id
                   AND record.actor_service IS NULL
                   AND record.target_type = 'voice_flow'
                   AND record.request_id IS NULL
                   AND record.metadata = jsonb_build_object(
                     'version', CAST(:flow_version AS integer)
                   )
                   AND EXISTS (
                     SELECT 1 FROM flows flow
                     WHERE flow.flow_id = :flow_id
                       AND flow.version = CAST(:flow_version AS integer)
                       AND flow.tenant_id = :tenant_id
                   ) AS safe
            FROM audit.records record
            WHERE record.tenant_id = :tenant_id
              AND record.action = 'voice.flow.published'
              AND record.target_id = :flow_id
        """,
        parameters=parameters,
    )

    rows = {
        ("ops", "jobs"): voice_job_rows,
        ("audit", "records"): (*voice_job_audit_rows, *flow_audit_rows),
        ("public", "flows"): flow_rows,
    }
    targets = (
        _exact_rows_target(
            "primary_voice_simulator_job_audit", "audit.records", voice_job_audit_rows
        ),
        _exact_rows_target("primary_voice_simulator_jobs", "ops.jobs", voice_job_rows),
        _exact_rows_target("fictional_welcome_flow_audit", "audit.records", flow_audit_rows),
        _exact_rows_target(
            "fictional_welcome_flow",
            "flows",
            flow_rows,
            key_columns=("tenant_id", "flow_id", "version"),
        ),
    )
    return DiscoveredCleanup(rows=rows, targets=targets)


async def _tenant_owned_tables(connection: AsyncConnection) -> tuple[tuple[str, str], ...]:
    """Return ordinary tables carrying canonical tenant ownership."""

    rows = await connection.execute(
        text(
            """
            SELECT namespace.nspname AS schema_name, relation.relname AS table_name
            FROM pg_catalog.pg_class relation
            JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
            JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
            WHERE relation.relkind IN ('r', 'p')
              AND attribute.attname = 'tenant_id'
              AND NOT attribute.attisdropped
              AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
              AND namespace.nspname NOT LIKE 'pg_toast%'
              AND NOT EXISTS (
                SELECT 1 FROM pg_catalog.pg_inherits inheritance
                WHERE inheritance.inhrelid = relation.oid
              )
            ORDER BY namespace.nspname, relation.relname
            """
        )
    )
    return tuple((str(row.schema_name), str(row.table_name)) for row in rows)


def _append_rows(
    destination: dict[tuple[str, str], list[dict[str, Any]]],
    table: tuple[str, str],
    rows: Sequence[dict[str, Any]],
) -> None:
    bucket = destination.setdefault(table, [])
    for row in rows:
        if row not in bucket:
            bucket.append(row)


async def _discover_test_tenants(connection: AsyncConnection) -> DiscoveredCleanup:
    """Find only leaked tenants carrying exact repository-test identities."""

    candidates = await _validated_key_rows(
        connection,
        label="recognized leaked test tenants",
        statement="""
            SELECT id, name, slug,
                   status = 'active'
                   AND (
                     (id = '00000000-0000-0000-0000-000000000001'::uuid
                      AND name = 'Default' AND slug = 'default')
                     OR (name IN ('Importer tenant', 'SQLite importer tenant')
                         AND slug = 'phase2b-' || id::text)
                     OR (name IN ('Phase 4 API', 'Other API tenant')
                         AND slug = 'phase4-api-' || id::text)
                   ) AS safe
            FROM tenants
            WHERE id = '00000000-0000-0000-0000-000000000001'::uuid
               OR (name IN ('Importer tenant', 'SQLite importer tenant')
                   AND slug LIKE 'phase2b-%')
               OR (name IN ('Phase 4 API', 'Other API tenant')
                   AND slug LIKE 'phase4-api-%')
        """,
        parameters={},
    )
    if not candidates:
        return DiscoveredCleanup(rows={}, targets=())

    tables = await _tenant_owned_tables(connection)
    dynamic_rows: dict[tuple[str, str], list[dict[str, Any]]] = {
        ("public", "tenants"): [{"id": row["id"]} for row in candidates]
    }
    candidate_ids_by_table: dict[tuple[str, str], list[UUID]] = {}
    candidate_users: list[dict[str, Any]] = []

    for candidate in candidates:
        tenant_id = UUID(str(candidate["id"]))
        name = str(candidate["name"])
        allowed_tables = TEST_TENANT_TABLES[name]
        for schema_name, table_name in tables:
            qualified = f"{_quote_identifier(schema_name)}.{_quote_identifier(table_name)}"
            count = int(
                (
                    await connection.scalar(
                        text(
                            f"SELECT count(*) FROM {qualified} "  # noqa: S608
                            "WHERE tenant_id = :tenant_id"
                        ),
                        {"tenant_id": tenant_id},
                    )
                )
                or 0
            )
            if not count:
                continue
            if (schema_name, table_name) not in allowed_tables:
                raise RuntimeError(
                    "refusing cleanup: recognized test tenant contains unexpected "
                    f"tenant-owned data ({schema_name}.{table_name}: {count})"
                )
            candidate_ids_by_table.setdefault((schema_name, table_name), []).append(tenant_id)

        membership_rows = await _validated_key_rows(
            connection,
            label=f"{name} memberships",
            statement="""
                SELECT membership.tenant_id, membership.user_id,
                       membership.role = 'owner'
                       AND account.status = 'active'
                       AND lower(account.email) = lower(account.id::text || '@example.test') AS safe
                FROM memberships membership
                JOIN users account ON account.id = membership.user_id
                WHERE membership.tenant_id = :tenant_id
            """,
            parameters={"tenant_id": tenant_id},
        )
        if name in {"Importer tenant", "SQLite importer tenant", "Phase 4 API"}:
            if len(membership_rows) != 1:
                raise RuntimeError(
                    f"refusing cleanup: {name} must have exactly one @example.test owner"
                )
        elif membership_rows:
            raise RuntimeError(f"refusing cleanup: {name} must remain memberless")
        _append_rows(dynamic_rows, ("public", "memberships"), membership_rows)
        for membership in membership_rows:
            user = {"id": membership["user_id"]}
            if user not in candidate_users:
                candidate_users.append(user)

        if name in {"Importer tenant", "SQLite importer tenant"}:
            run_rows = await _validated_key_rows(
                connection,
                label=f"{name} import runs",
                statement="""
                    SELECT run.id, run.tenant_id,
                           run.source_system = 'openlive_legacy'
                           AND run.status = 'completed'
                           AND run.requested_by_user_id IN (
                             SELECT user_id FROM memberships WHERE tenant_id = :tenant_id
                           ) AS safe
                    FROM ops.import_runs run
                    WHERE run.tenant_id = :tenant_id
                """,
                parameters={"tenant_id": tenant_id},
            )
            if len(run_rows) != 1:
                raise RuntimeError(f"refusing cleanup: {name} import lineage is not exact")
            item_rows = await _validated_key_rows(
                connection,
                label=f"{name} import items",
                statement="""
                    SELECT item.tenant_id, item.import_run_id,
                           item.source_kind, item.source_id,
                           item.target_kind = item.source_kind
                           AND item.target_id IS NOT NULL
                           AND item.status = 'imported'
                           AND item.error_safe IS NULL
                           AND item.source_kind IN (
                             'chat', 'message', 'provider_configuration',
                             'user_preference', 'voice_profile'
                           ) AS safe
                    FROM ops.import_items item
                    WHERE item.tenant_id = :tenant_id
                """,
                parameters={"tenant_id": tenant_id},
            )
            _append_rows(dynamic_rows, ("ops", "import_runs"), run_rows)
            _append_rows(dynamic_rows, ("ops", "import_items"), item_rows)

            chat_rows = await _validated_key_rows(
                connection,
                label=f"{name} imported chats",
                statement="""
                    SELECT chat.id, chat.tenant_id,
                           chat.legacy_source_id IS NOT NULL
                           AND chat.owner_user_id IN (
                             SELECT user_id FROM memberships WHERE tenant_id = :tenant_id
                           )
                           AND EXISTS (
                             SELECT 1 FROM ops.import_items item
                             WHERE item.tenant_id = chat.tenant_id
                               AND item.target_kind = 'chat'
                               AND item.target_id = chat.id
                           ) AS safe
                    FROM live.chats chat WHERE chat.tenant_id = :tenant_id
                """,
                parameters={"tenant_id": tenant_id},
            )
            message_rows = await _validated_key_rows(
                connection,
                label=f"{name} imported live messages",
                statement="""
                    SELECT message.id, message.tenant_id,
                           message.legacy_source_id IS NOT NULL
                           AND message.provider IS NULL
                           AND EXISTS (
                             SELECT 1 FROM ops.import_items item
                             WHERE item.tenant_id = message.tenant_id
                               AND item.target_kind = 'message'
                               AND item.target_id = message.id
                           ) AS safe
                    FROM live.messages message WHERE message.tenant_id = :tenant_id
                """,
                parameters={"tenant_id": tenant_id},
            )
            preference_rows = await _validated_key_rows(
                connection,
                label=f"{name} imported preferences",
                statement="""
                    SELECT preference.tenant_id, preference.user_id, preference.key,
                           preference.source = 'legacy_import'
                           AND preference.user_id IN (
                             SELECT user_id FROM memberships WHERE tenant_id = :tenant_id
                           )
                           AND EXISTS (
                             SELECT 1 FROM ops.import_items item
                             WHERE item.tenant_id = preference.tenant_id
                               AND item.target_kind = 'user_preference'
                               AND item.source_id = preference.key
                           ) AS safe
                    FROM live.user_preferences preference
                    WHERE preference.tenant_id = :tenant_id
                """,
                parameters={"tenant_id": tenant_id},
            )
            provider_rows = await _validated_key_rows(
                connection,
                label=f"{name} imported provider configurations",
                statement="""
                    SELECT configuration.id, configuration.tenant_id,
                           configuration.owner_user_id IN (
                             SELECT user_id FROM memberships WHERE tenant_id = :tenant_id
                           )
                           AND configuration.credential_id IS NULL
                           AND NOT configuration.is_enabled
                           AND configuration.settings = '{}'::jsonb
                           AND EXISTS (
                             SELECT 1 FROM ops.import_items item
                             WHERE item.tenant_id = configuration.tenant_id
                               AND item.target_kind = 'provider_configuration'
                               AND item.target_id = configuration.id
                           ) AS safe
                    FROM live.provider_configurations configuration
                    WHERE configuration.tenant_id = :tenant_id
                """,
                parameters={"tenant_id": tenant_id},
            )
            voice_rows = await _validated_key_rows(
                connection,
                label=f"{name} imported voice profiles",
                statement="""
                    SELECT profile.id, profile.tenant_id,
                           profile.owner_user_id IN (
                             SELECT user_id FROM memberships WHERE tenant_id = :tenant_id
                           )
                           AND profile.object_id IS NULL
                           AND profile.source_kind = 'legacy_import'
                           AND EXISTS (
                             SELECT 1 FROM ops.import_items item
                             WHERE item.tenant_id = profile.tenant_id
                               AND item.target_kind = 'voice_profile'
                               AND item.target_id = profile.id
                           ) AS safe
                    FROM live.voice_profiles profile WHERE profile.tenant_id = :tenant_id
                """,
                parameters={"tenant_id": tenant_id},
            )
            _append_rows(dynamic_rows, ("live", "chats"), chat_rows)
            _append_rows(dynamic_rows, ("live", "messages"), message_rows)
            _append_rows(dynamic_rows, ("live", "user_preferences"), preference_rows)
            _append_rows(dynamic_rows, ("live", "provider_configurations"), provider_rows)
            _append_rows(dynamic_rows, ("live", "voice_profiles"), voice_rows)

            item_count = len(item_rows)
            represented = (
                len(chat_rows)
                + len(message_rows)
                + len(preference_rows)
                + len(provider_rows)
                + len(voice_rows)
            )
            if item_count != represented:
                raise RuntimeError(
                    f"refusing cleanup: {name} import ledger and canonical rows differ"
                )

        if name == "Phase 4 API":
            api_key_rows = await _validated_key_rows(
                connection,
                label="Phase 4 API keys",
                statement="""
                    SELECT key.id, key.tenant_id,
                           key.name = 'Phase 4 fixture'
                           AND key.prefix = 'oron_fixture'
                           AND key.hashed_key LIKE 'phase4-digest-%'
                           AND key.scopes = ARRAY['crm:read']::text[]
                           AND key.created_by_user_id IN (
                             SELECT user_id FROM memberships WHERE tenant_id = :tenant_id
                           ) AS safe
                    FROM api_keys key WHERE key.tenant_id = :tenant_id
                """,
                parameters={"tenant_id": tenant_id},
            )
            if len(api_key_rows) != 1:
                raise RuntimeError("refusing cleanup: Phase 4 API key fixture is not exact")
            _append_rows(dynamic_rows, ("public", "api_keys"), api_key_rows)

    if candidate_users:
        user_ids = tuple(UUID(str(row["id"])) for row in candidate_users)
        unsafe_users = int(
            (
                await connection.scalar(
                    text(
                        "SELECT count(*) FROM users "
                        "WHERE id = ANY(CAST(:user_ids AS uuid[])) "
                        "AND (status <> 'active' OR lower(email) <> "
                        "lower(id::text || '@example.test'))"
                    ),
                    {"user_ids": list(user_ids)},
                )
            )
            or 0
        )
        if unsafe_users:
            raise RuntimeError(
                "refusing cleanup: recognized test tenant contains a non-test user identity"
            )
        _append_rows(dynamic_rows, ("public", "users"), candidate_users)

    targets: list[CleanupTarget] = []
    membership_targets: list[CleanupTarget] = []
    for schema_name, table_name in TEST_TENANT_DELETE_ORDER:
        tenant_ids = tuple(candidate_ids_by_table.get((schema_name, table_name), ()))
        if tenant_ids:
            target = _tenant_rows_target(
                f"test_tenant_{schema_name}_{table_name}",
                schema_name,
                table_name,
                tenant_ids,
            )
            # The production last-owner trigger deliberately rejects deleting an
            # owner's membership while its tenant still exists. Delete the fully
            # validated tenant after every other child; its FK cascade then removes
            # memberships through the trigger's explicit tenant-deletion path.
            if (schema_name, table_name) == ("public", "memberships"):
                membership_targets.append(target)
            else:
                targets.append(target)
    targets.append(
        _exact_rows_target(
            "recognized_test_tenants",
            "tenants",
            candidates,
            key_columns=("id",),
        )
    )
    targets.extend(membership_targets)
    if candidate_users:
        targets.append(
            _exact_rows_target(
                "orphaned_example_test_users",
                "users",
                candidate_users,
                key_columns=("id",),
            )
        )
    return DiscoveredCleanup(
        rows={table: tuple(rows) for table, rows in dynamic_rows.items()},
        targets=tuple(targets),
    )


async def _primary_workspace_normalization(connection: AsyncConnection) -> CleanupTarget:
    """Prepare only the approved untouched seed-name normalization."""

    row = (
        (
            await connection.execute(
                text("SELECT name, slug FROM tenants WHERE id = :tenant_id"),
                {"tenant_id": PRIMARY_TENANT},
            )
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise RuntimeError("refusing cleanup: primary workspace is missing")
    identity = (str(row["name"]), str(row["slug"]))
    if identity not in {PRIMARY_SEED_IDENTITY, PRIMARY_PRODUCT_IDENTITY}:
        raise RuntimeError("refusing cleanup: primary workspace name or slug was customized")
    parameters = {
        "tenant_id": PRIMARY_TENANT,
        "old_name": PRIMARY_SEED_IDENTITY[0],
        "old_slug": PRIMARY_SEED_IDENTITY[1],
        "new_name": PRIMARY_PRODUCT_IDENTITY[0],
        "new_slug": PRIMARY_PRODUCT_IDENTITY[1],
    }
    return CleanupTarget(
        label="normalize_primary_workspace_identity",
        count_sql=(
            "SELECT count(*) FROM tenants WHERE id = :tenant_id "
            "AND name = :old_name AND slug = :old_slug"
        ),
        delete_sql=(
            "UPDATE tenants SET name = :new_name, slug = :new_slug, "
            "updated_at = CURRENT_TIMESTAMP WHERE id = :tenant_id "
            "AND name = :old_name AND slug = :old_slug"
        ),
        parameters=parameters,
        operation="update",
    )


def _reference_probe(
    *,
    child: tuple[str, str],
    child_columns: Sequence[str],
    parent_columns: Sequence[str],
    parent_row: dict[str, Any],
    constraint_name: str,
    fixtures: dict[tuple[str, str], tuple[dict[str, Any], ...]] | None = None,
) -> tuple[str, dict[str, Any]]:
    """Build a count query for non-fixture children of one exact fixture row."""

    if len(child_columns) != len(parent_columns) or not child_columns:
        raise RuntimeError(f"cannot inspect malformed foreign key {constraint_name}")
    missing = [column for column in parent_columns if column not in parent_row]
    if missing:
        raise RuntimeError(
            f"cannot safely inspect foreign key {constraint_name}; fixture key lacks "
            + ", ".join(missing)
        )

    parameters: dict[str, Any] = {}
    reference_terms: list[str] = []
    for position, (child_column, parent_column) in enumerate(
        zip(child_columns, parent_columns, strict=True)
    ):
        parameter = f"reference_{position}"
        parameters[parameter] = parent_row[parent_column]
        reference_terms.append(f"{_quote_identifier(child_column)} = :{parameter}")

    known_child_terms: list[str] = []
    known_rows = known_fixture_rows() if fixtures is None else fixtures
    for row_position, known_row in enumerate(known_rows.get(child, ())):
        row_terms: list[str] = []
        for column_position, (column, value) in enumerate(sorted(known_row.items())):
            parameter = f"known_{row_position}_{column_position}"
            parameters[parameter] = value
            row_terms.append(f"{_quote_identifier(column)} = :{parameter}")
        known_child_terms.append("(" + " AND ".join(row_terms) + ")")

    qualified = f"{_quote_identifier(child[0])}.{_quote_identifier(child[1])}"
    # Schema/table/column names come only from pg_catalog and are quoted above;
    # every row value remains a bound parameter.
    statement = (
        f"SELECT count(*) FROM {qualified} WHERE "  # noqa: S608
        + " AND ".join(reference_terms)
    )
    if known_child_terms:
        statement += " AND NOT (" + " OR ".join(known_child_terms) + ")"
    return statement, parameters


async def _unexpected_primary_fixture_references(
    connection: AsyncConnection,
    fixtures: dict[tuple[str, str], tuple[dict[str, Any], ...]] | None = None,
) -> dict[str, int]:
    """Find any non-fixture row that refers to a fixture selected for deletion."""

    foreign_keys = await connection.execute(
        text(
            """
            SELECT constraint_record.conname AS constraint_name,
                   child_namespace.nspname AS child_schema,
                   child_relation.relname AS child_table,
                   parent_namespace.nspname AS parent_schema,
                   parent_relation.relname AS parent_table,
                   jsonb_agg(child_attribute.attname ORDER BY child_key.position)
                     AS child_columns,
                   jsonb_agg(parent_attribute.attname ORDER BY child_key.position)
                     AS parent_columns
            FROM pg_catalog.pg_constraint constraint_record
            JOIN pg_catalog.pg_class child_relation
              ON child_relation.oid = constraint_record.conrelid
            JOIN pg_catalog.pg_namespace child_namespace
              ON child_namespace.oid = child_relation.relnamespace
            JOIN pg_catalog.pg_class parent_relation
              ON parent_relation.oid = constraint_record.confrelid
            JOIN pg_catalog.pg_namespace parent_namespace
              ON parent_namespace.oid = parent_relation.relnamespace
            CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY
              AS child_key(attnum, position)
            JOIN LATERAL unnest(constraint_record.confkey) WITH ORDINALITY
              AS parent_key(attnum, position)
              ON parent_key.position = child_key.position
            JOIN pg_catalog.pg_attribute child_attribute
              ON child_attribute.attrelid = child_relation.oid
             AND child_attribute.attnum = child_key.attnum
            JOIN pg_catalog.pg_attribute parent_attribute
              ON parent_attribute.attrelid = parent_relation.oid
             AND parent_attribute.attnum = parent_key.attnum
            WHERE constraint_record.contype = 'f'
            GROUP BY constraint_record.oid, constraint_record.conname,
                     child_namespace.nspname, child_relation.relname,
                     parent_namespace.nspname, parent_relation.relname
            ORDER BY child_namespace.nspname, child_relation.relname,
                     constraint_record.conname
            """
        )
    )
    fixture_rows = known_fixture_rows() if fixtures is None else fixtures
    unexpected: dict[str, int] = {}
    for foreign_key in foreign_keys.mappings():
        parent = (str(foreign_key["parent_schema"]), str(foreign_key["parent_table"]))
        parent_rows = fixture_rows.get(parent)
        if not parent_rows:
            continue
        child = (str(foreign_key["child_schema"]), str(foreign_key["child_table"]))
        constraint_name = str(foreign_key["constraint_name"])
        child_columns = tuple(str(value) for value in foreign_key["child_columns"])
        parent_columns = tuple(str(value) for value in foreign_key["parent_columns"])
        for parent_position, parent_row in enumerate(parent_rows):
            statement, parameters = _reference_probe(
                child=child,
                child_columns=child_columns,
                parent_columns=parent_columns,
                parent_row=parent_row,
                constraint_name=constraint_name,
                fixtures=fixture_rows,
            )
            count = int((await connection.scalar(text(statement), parameters)) or 0)
            if count:
                label = (
                    f"{child[0]}.{child[1]} via {constraint_name} "
                    f"to {parent[0]}.{parent[1]} fixture {parent_position + 1}"
                )
                unexpected[label] = count
    return unexpected


async def _unexpected_soft_fixture_references(
    connection: AsyncConnection,
    fixtures: dict[tuple[str, str], tuple[dict[str, Any], ...]],
) -> dict[str, int]:
    """Protect generic UUID references that PostgreSQL cannot enforce as FKs."""

    protected_ids: list[UUID] = []
    for table, rows in fixtures.items():
        if table in {
            ("public", "tenants"),
            ("public", "users"),
            ("public", "memberships"),
        }:
            continue
        for row in rows:
            value = row.get("id", row.get("session_id"))
            if isinstance(value, UUID) and value not in protected_ids:
                protected_ids.append(value)
    if not protected_ids:
        return {}

    parameters: dict[str, Any] = {
        f"protected_{index}": value for index, value in enumerate(protected_ids)
    }
    placeholders = ", ".join(f":protected_{index}" for index in range(len(protected_ids)))
    checks = (
        ("ops.jobs.reference_id", "ops.jobs", "reference_id", ("ops", "jobs")),
        (
            "ops.outbox_events.aggregate_id",
            "ops.outbox_events",
            "aggregate_id",
            ("ops", "outbox_events"),
        ),
        ("audit.records.target_id", "audit.records", "target_id", ("audit", "records")),
        (
            "messaging.notifications.reference_id",
            "messaging.notifications",
            "reference_id",
            ("messaging", "notifications"),
        ),
        ("ops.import_items.target_id", "ops.import_items", "target_id", ("ops", "import_items")),
    )
    unexpected: dict[str, int] = {}
    for label, table, column, known_table in checks:
        known_ids = tuple(
            row["id"] for row in fixtures.get(known_table, ()) if isinstance(row.get("id"), UUID)
        )
        local_parameters = dict(parameters)
        exclusion = ""
        if known_ids:
            known_placeholders: list[str] = []
            for index, value in enumerate(known_ids):
                parameter = f"known_{index}"
                local_parameters[parameter] = value
                known_placeholders.append(f":{parameter}")
            exclusion = " AND id NOT IN (" + ", ".join(known_placeholders) + ")"
        statement = (
            f"SELECT count(*) FROM {table} "  # noqa: S608
            f"WHERE {column} IN ({placeholders}){exclusion}"  # noqa: S608
        )
        count = int((await connection.scalar(text(statement), local_parameters)) or 0)
        if count:
            unexpected[label] = count
    return unexpected


async def _unexpected_secondary_tenant_rows(connection: AsyncConnection) -> dict[str, int]:
    """Find tenant-owned rows not created by the retired deterministic seed."""

    table_rows = await connection.execute(
        text(
            """
            SELECT namespace.nspname AS schema_name, relation.relname AS table_name
            FROM pg_catalog.pg_class relation
            JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
            JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
            WHERE relation.relkind IN ('r', 'p')
              AND attribute.attname = 'tenant_id'
              AND NOT attribute.attisdropped
              AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
              AND namespace.nspname NOT LIKE 'pg_toast%'
              AND NOT EXISTS (
                SELECT 1 FROM pg_catalog.pg_inherits inheritance
                WHERE inheritance.inhrelid = relation.oid
              )
            ORDER BY namespace.nspname, relation.relname
            """
        )
    )
    unexpected: dict[str, int] = {}
    for row in table_rows.mappings():
        schema_name = str(row["schema_name"])
        table_name = str(row["table_name"])
        qualified = f"{_quote_identifier(schema_name)}.{_quote_identifier(table_name)}"
        if (schema_name, table_name) == ("public", "memberships"):
            statement = text(
                f"SELECT count(*) FROM {qualified} "  # noqa: S608
                "WHERE tenant_id = :tenant_id "
                "AND (user_id <> :user_id OR role <> 'admin')"
            )
            parameters = {"tenant_id": SECONDARY_DEMO_TENANT, "user_id": PRIMARY_USER}
        elif (schema_name, table_name) == ("audit", "records"):
            statement = text(
                f"SELECT count(*) FROM {qualified} "  # noqa: S608
                "WHERE tenant_id = :tenant_id AND NOT ("
                "actor_user_id = :user_id AND actor_service IS NULL "
                "AND action IN ('auth.tenant.switched', 'auth.session.revoked') "
                "AND target_type = 'auth_session' AND request_id IS NOT NULL)"
            )
            parameters = {"tenant_id": SECONDARY_DEMO_TENANT, "user_id": PRIMARY_USER}
        else:
            statement = text(
                f"SELECT count(*) FROM {qualified} WHERE tenant_id = :tenant_id"  # noqa: S608
            )
            parameters = {"tenant_id": SECONDARY_DEMO_TENANT}
        count = int((await connection.scalar(statement, parameters)) or 0)
        if count:
            unexpected[f"{schema_name}.{table_name}"] = count

    tenant = (
        (
            await connection.execute(
                text("SELECT name, slug FROM tenants WHERE id = :tenant_id"),
                {"tenant_id": SECONDARY_DEMO_TENANT},
            )
        )
        .mappings()
        .one_or_none()
    )
    if tenant and (tenant["name"], tenant["slug"]) != ("Northstar Studio", "northstar-studio"):
        unexpected["tenants (identity changed)"] = 1
    return unexpected


def refuse_unknown_demo_data(unexpected: dict[str, int]) -> None:
    """Fail without exposing row values when the demo tenant has been used."""

    if not unexpected:
        return
    summary = ", ".join(f"{table}: {count}" for table, count in sorted(unexpected.items()))
    raise RuntimeError(
        f"refusing cleanup: the retired demo tenant contains unknown tenant-owned data ({summary})"
    )


def refuse_fixture_references(unexpected: dict[str, int]) -> None:
    """Refuse cascades that would remove non-fixture children of fixture rows."""

    if not unexpected:
        return
    summary = ", ".join(f"{relation}: {count}" for relation, count in sorted(unexpected.items()))
    raise RuntimeError(
        f"refusing cleanup: known demo records are referenced by non-fixture data ({summary})"
    )


async def clean(*, apply: bool = False) -> dict[str, int]:
    """Inspect or remove exact fixtures, returning per-target affected counts."""

    load_dotenv(".env", override=True)
    url = guarded_database_url(os.environ.get("MIGRATION_DATABASE_URL"))
    engine = create_async_engine(url)
    affected: dict[str, int] = {}
    try:
        async with engine.begin() as connection:
            simulator_cleanup = await _discover_simulator_dependents(connection)
            primary_voice_cleanup = await _discover_primary_voice_artifacts(connection)
            test_tenant_cleanup = await _discover_test_tenants(connection)
            normalization = await _primary_workspace_normalization(connection)
            primary_fixtures = _merge_fixture_rows(
                known_fixture_rows(), simulator_cleanup.rows, primary_voice_cleanup.rows
            )
            all_fixtures = _merge_fixture_rows(primary_fixtures, test_tenant_cleanup.rows)
            refuse_fixture_references(
                await _unexpected_primary_fixture_references(connection, all_fixtures)
            )
            refuse_fixture_references(
                await _unexpected_soft_fixture_references(connection, primary_fixtures)
            )
            refuse_unknown_demo_data(await _unexpected_secondary_tenant_rows(connection))
            targets = (
                *simulator_cleanup.targets,
                *primary_voice_cleanup.targets,
                *cleanup_targets(),
                *test_tenant_cleanup.targets,
                normalization,
            )
            for target in targets:
                if apply:
                    result = await connection.execute(text(target.delete_sql), target.parameters)
                    affected[target.label] = result.rowcount
                else:
                    count = await connection.scalar(text(target.count_sql), target.parameters)
                    affected[target.label] = int(count or 0)
    finally:
        await engine.dispose()

    mode = "applied" if apply else "dry run; no rows changed"
    print(f"Development demo cleanup {mode}:")
    operations = {
        target.label: target.operation
        for target in (
            *simulator_cleanup.targets,
            *primary_voice_cleanup.targets,
            *cleanup_targets(),
            *test_tenant_cleanup.targets,
            normalization,
        )
    }
    for label, count in affected.items():
        operation = operations[label]
        verb = (
            ("updated" if operation == "update" else "removed")
            if apply
            else ("would update" if operation == "update" else "would remove")
        )
        print(f"- {label}: {verb} {count}")
    if not apply:
        print("Re-run with --apply only after reviewing this exact fixture plan.")
    return affected


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="execute the exact reviewed deletions (the default is read-only)",
    )
    return parser.parse_args(argv)


if __name__ == "__main__":
    arguments = parse_args()
    asyncio.run(clean(apply=arguments.apply))
