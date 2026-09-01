"""Canonical PostgreSQL writer for Phase 2B importer validation."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING
from uuid import UUID

import asyncpg

from .models import ImportPlan, ImportRecord, ImportResult

if TYPE_CHECKING:
    from asyncpg import Connection


class PostgresCanonicalWriter:
    """Apply a deterministic plan through canonical tables and import ledgers."""

    def __init__(self, database_url: str) -> None:
        normalized = database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
        if not normalized.startswith("postgresql://"):
            raise ValueError("legacy importer destination must be PostgreSQL")
        self._database_url = normalized

    def write(self, plan: ImportPlan) -> ImportResult:
        return asyncio.run(self.write_async(plan))

    async def write_async(self, plan: ImportPlan) -> ImportResult:
        connection = await asyncpg.connect(self._database_url)
        try:
            async with connection.transaction():
                return await self._write_transaction(connection, plan)
        finally:
            await connection.close()

    async def _write_transaction(self, connection: Connection, plan: ImportPlan) -> ImportResult:
        run = await connection.fetchrow(
            """
            INSERT INTO ops.import_runs (
              tenant_id, source_system, source_checksum, requested_by_user_id, status, plan
            ) VALUES ($1, 'openlive_legacy', $2, $3, 'running', $4::jsonb)
            ON CONFLICT (tenant_id, source_system, source_checksum)
            DO UPDATE SET source_checksum = EXCLUDED.source_checksum
            RETURNING id, status
            """,
            plan.tenant_id,
            plan.source_checksum,
            plan.user_id,
            json.dumps(plan.safe_summary(), sort_keys=True),
        )
        assert run is not None
        run_id = UUID(str(run["id"]))
        if run["status"] == "completed":
            imported_count = await connection.fetchval(
                "SELECT count(*) FROM ops.import_items "
                "WHERE import_run_id = $1 AND status = 'imported'",
                run_id,
            )
            assert imported_count is not None
            return ImportResult(
                import_run_id=run_id,
                imported_count=int(imported_count),
                skipped_count=len(plan.records),
            )

        imported_count = 0
        skipped_count = 0
        for record in plan.records:
            imported = await connection.fetchval(
                """
                SELECT EXISTS (
                  SELECT 1 FROM ops.import_items
                  WHERE import_run_id = $1 AND source_kind = $2 AND source_id = $3
                    AND source_checksum = $4 AND status = 'imported'
                )
                """,
                run_id,
                record.kind,
                record.source_id,
                record.checksum,
            )
            if imported:
                skipped_count += 1
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
                              status = 'imported',
                              error_safe = NULL
                """,
                plan.tenant_id,
                run_id,
                record.kind,
                record.source_id,
                record.checksum,
                record.target_id,
            )
            imported_count += 1

        await connection.execute(
            "UPDATE ops.import_runs SET status = 'completed', completed_at = CURRENT_TIMESTAMP "
            "WHERE id = $1",
            run_id,
        )
        return ImportResult(
            import_run_id=run_id,
            imported_count=imported_count,
            skipped_count=skipped_count,
        )

    async def _write_record(self, connection: Connection, record: ImportRecord) -> None:
        payload = record.payload
        if record.kind == "chat":
            await connection.execute(
                """
                INSERT INTO live.chats (
                  id, tenant_id, owner_user_id, title, agent_id, workspace_path,
                  external_session_id, legacy_source_id, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz)
                ON CONFLICT (id) DO NOTHING
                """,
                record.target_id,
                UUID(str(payload["tenant_id"])),
                UUID(str(payload["owner_user_id"])),
                payload["title"],
                payload["agent_id"],
                payload["workspace_path"],
                payload["external_session_id"],
                record.source_id,
                payload["created_at"],
                payload["updated_at"],
            )
        elif record.kind == "message":
            await connection.execute(
                """
                INSERT INTO live.messages (
                  id, tenant_id, chat_id, sequence, legacy_source_id, role,
                  content, is_live, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::timestamptz)
                ON CONFLICT (id) DO NOTHING
                """,
                record.target_id,
                UUID(str(payload["tenant_id"])),
                UUID(str(payload["chat_target_id"])),
                payload["sequence"],
                record.source_id,
                payload["role"],
                json.dumps(payload["content"], sort_keys=True),
                payload["is_live"],
                payload["created_at"],
            )
        elif record.kind == "provider_configuration":
            await connection.execute(
                """
                INSERT INTO live.provider_configurations (
                  id, tenant_id, owner_user_id, provider_kind, name, display_hint,
                  settings, is_default, is_enabled
                ) VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, false)
                ON CONFLICT (id) DO NOTHING
                """,
                record.target_id,
                UUID(str(payload["tenant_id"])),
                UUID(str(payload["owner_user_id"])),
                payload["provider_kind"],
                payload["name"],
                payload["display_hint"],
                payload["is_default"],
            )
        elif record.kind == "user_preference":
            await connection.execute(
                """
                INSERT INTO live.user_preferences (tenant_id, user_id, key, value, source)
                VALUES ($1, $2, $3, $4::jsonb, 'legacy_import')
                ON CONFLICT (tenant_id, user_id, key)
                DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source,
                              updated_at = CURRENT_TIMESTAMP
                """,
                UUID(str(payload["tenant_id"])),
                UUID(str(payload["user_id"])),
                payload["key"],
                json.dumps(payload["value"], sort_keys=True),
            )
        elif record.kind == "voice_profile":
            await connection.execute(
                """
                INSERT INTO live.voice_profiles (
                  id, tenant_id, owner_user_id, name, transcript, duration_seconds,
                  source_kind, metadata, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, 'legacy_import', $7::jsonb, $8::timestamptz)
                ON CONFLICT (id) DO NOTHING
                """,
                record.target_id,
                UUID(str(payload["tenant_id"])),
                UUID(str(payload["owner_user_id"])),
                payload["name"],
                payload["transcript"],
                payload["duration_seconds"],
                json.dumps(payload["metadata"], sort_keys=True),
                payload["created_at"],
            )
        else:
            raise ValueError(f"unsupported canonical import record kind: {record.kind}")
