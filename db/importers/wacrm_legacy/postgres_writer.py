"""Canonical PostgreSQL writer for the provider-neutral WACRM export plan."""

from __future__ import annotations

import json
from collections import defaultdict
from decimal import Decimal
from uuid import UUID

import asyncpg

from .contracts import WacrmImportPlan, WacrmImportRecord, WacrmImportResult


def _integer(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError(f"{label} must be an integer")
    return int(value)


class WacrmPostgresWriter:
    def __init__(self, database_url: str) -> None:
        normalized = database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
        if not normalized.startswith("postgresql://"):
            raise ValueError("WACRM importer destination must be PostgreSQL")
        self._database_url = normalized

    async def write_async(self, plan: WacrmImportPlan) -> WacrmImportResult:
        connection = await asyncpg.connect(self._database_url)
        try:
            async with connection.transaction():
                grouped: dict[UUID, list[WacrmImportRecord]] = defaultdict(list)
                for record in plan.records:
                    grouped[record.tenant_id].append(record)
                run_ids: list[UUID] = []
                imported_count = 0
                skipped_count = 0
                for tenant_id, records in grouped.items():
                    run_id, imported, skipped = await self._write_tenant(
                        connection, plan, tenant_id, records
                    )
                    run_ids.append(run_id)
                    imported_count += imported
                    skipped_count += skipped
                return WacrmImportResult(
                    tuple(sorted(run_ids, key=str)), imported_count, skipped_count
                )
        finally:
            await connection.close()

    async def _write_tenant(
        self,
        connection: asyncpg.Connection,
        plan: WacrmImportPlan,
        tenant_id: UUID,
        records: list[WacrmImportRecord],
    ) -> tuple[UUID, int, int]:
        run = await connection.fetchrow(
            """
            INSERT INTO ops.import_runs (tenant_id, source_system, source_checksum, status, plan)
            VALUES ($1, 'wacrm_export', $2, 'running', $3::jsonb)
            ON CONFLICT (tenant_id, source_system, source_checksum)
            DO UPDATE SET source_checksum = EXCLUDED.source_checksum
            RETURNING id, status
            """,
            tenant_id,
            plan.source_checksum,
            json.dumps(plan.safe_summary(), sort_keys=True),
        )
        assert run is not None
        run_id = UUID(str(run["id"]))
        if run["status"] == "completed":
            return run_id, 0, len(records)

        imported = 0
        skipped = 0
        for record in records:
            exists = await connection.fetchval(
                "SELECT EXISTS (SELECT 1 FROM ops.import_items WHERE import_run_id = $1 "
                "AND source_kind = $2 AND source_id = $3 AND source_checksum = $4 "
                "AND status = 'imported')",
                run_id,
                record.kind,
                record.source_id,
                record.checksum,
            )
            if exists:
                skipped += 1
                continue
            await self._write_record(connection, record)
            await connection.execute(
                """
                INSERT INTO ops.import_items (
                  tenant_id, import_run_id, source_kind, source_id, source_checksum,
                  target_kind, target_id, status
                ) VALUES ($1, $2, $3, $4, $5, $3, $6, 'imported')
                ON CONFLICT (import_run_id, source_kind, source_id)
                DO UPDATE SET source_checksum = EXCLUDED.source_checksum,
                              target_kind = EXCLUDED.target_kind,
                              target_id = EXCLUDED.target_id,
                              status = 'imported', error_safe = NULL
                """,
                tenant_id,
                run_id,
                record.kind,
                record.source_id,
                record.checksum,
                record.target_id,
            )
            imported += 1
        await connection.execute(
            "UPDATE ops.import_runs SET status = 'completed', completed_at = CURRENT_TIMESTAMP "
            "WHERE id = $1",
            run_id,
        )
        return run_id, imported, skipped

    async def _write_record(
        self, connection: asyncpg.Connection, record: WacrmImportRecord
    ) -> None:
        payload = record.payload
        if record.kind == "contact":
            await connection.execute(
                "INSERT INTO crm.contacts (id, tenant_id, name, email, company) "
                "VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING",
                record.target_id,
                record.tenant_id,
                payload["name"],
                payload.get("email"),
                payload.get("company"),
            )
        elif record.kind == "channel":
            await connection.execute(
                "INSERT INTO messaging.channels "
                "(id, tenant_id, kind, provider, provider_account_id, display_address) "
                "VALUES ($1, $2, 'whatsapp', $3, $4, $5) ON CONFLICT (id) DO NOTHING",
                record.target_id,
                record.tenant_id,
                payload["provider"],
                payload.get("providerAccountId"),
                payload.get("displayAddress"),
            )
        elif record.kind == "conversation":
            await connection.execute(
                "INSERT INTO messaging.conversations "
                "(id, tenant_id, channel_id, contact_id, status, unread_count) "
                "VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING",
                record.target_id,
                record.tenant_id,
                UUID(str(payload["target_channelId"])),
                UUID(str(payload["target_contactId"])),
                payload.get("status", "open"),
                _integer(payload.get("unreadCount", 0), "unreadCount"),
            )
        elif record.kind == "message":
            await connection.execute(
                "INSERT INTO messaging.messages "
                "(id, tenant_id, conversation_id, direction, sender_type, content_type, "
                "content_text, provider, provider_message_id, status) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) "
                "ON CONFLICT (id) DO NOTHING",
                record.target_id,
                record.tenant_id,
                UUID(str(payload["target_conversationId"])),
                payload["direction"],
                payload["senderType"],
                payload.get("contentType", "text"),
                payload.get("contentText"),
                payload.get("provider"),
                payload.get("providerMessageId"),
                payload.get("status", "received"),
            )
        elif record.kind == "pipeline":
            await connection.execute(
                "INSERT INTO crm.pipelines (id, tenant_id, name, is_default) "
                "VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
                record.target_id,
                record.tenant_id,
                payload["name"],
                bool(payload.get("isDefault", False)),
            )
        elif record.kind == "pipeline_stage":
            await connection.execute(
                "INSERT INTO crm.pipeline_stages "
                "(id, tenant_id, pipeline_id, name, position, probability) "
                "VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING",
                record.target_id,
                record.tenant_id,
                UUID(str(payload["target_pipelineId"])),
                payload["name"],
                _integer(payload["position"], "position"),
                _integer(payload.get("probability", 0), "probability"),
            )
        elif record.kind == "deal":
            contact = payload.get("target_contactId")
            await connection.execute(
                "INSERT INTO crm.deals "
                "(id, tenant_id, pipeline_id, stage_id, contact_id, title, value, "
                "currency, status) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING",
                record.target_id,
                record.tenant_id,
                UUID(str(payload["target_pipelineId"])),
                UUID(str(payload["target_stageId"])),
                UUID(str(contact)) if contact is not None else None,
                payload["title"],
                Decimal(str(payload.get("value", "0"))),
                payload.get("currency", "USD"),
                payload.get("status", "open"),
            )
        else:
            raise ValueError(f"unsupported WACRM import record kind: {record.kind}")
