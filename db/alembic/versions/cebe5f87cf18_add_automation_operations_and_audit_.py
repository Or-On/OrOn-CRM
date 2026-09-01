"""Add automation, knowledge, object, durable-work, and audit foundations.

Revision ID: cebe5f87cf18
Revises: 2ef8ecd10c3d
Create Date: 2026-09-01 09:19:56.582503
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "cebe5f87cf18"
down_revision: str | None = "2ef8ecd10c3d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "object_metadata",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("owner_type", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=True),
        sa.Column("category", sa.Text(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("byte_size", sa.BigInteger(), nullable=False),
        sa.Column("checksum_algorithm", sa.Text(), nullable=False, server_default="sha256"),
        sa.Column("checksum", sa.Text(), nullable=False),
        sa.Column("storage_backend", sa.Text(), nullable=False),
        sa.Column("storage_key", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("retention_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.CheckConstraint("byte_size >= 0", name="ck_object_byte_size"),
        sa.CheckConstraint("storage_backend IN ('local', 'gcs')", name="ck_object_storage_backend"),
        sa.CheckConstraint(
            "status IN ('pending', 'available', 'quarantined', 'deleted')", name="ck_object_status"
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_object_metadata_tenant_id_id"),
        sa.UniqueConstraint("storage_backend", "storage_key", name="uq_object_storage_key"),
        schema="objects",
    )
    op.create_index(
        "ix_objects_owner",
        "object_metadata",
        ["tenant_id", "owner_type", "owner_id", "created_at", "id"],
        schema="objects",
    )
    op.create_index(
        "ix_objects_retention",
        "object_metadata",
        ["status", "retention_until", "id"],
        schema="objects",
        postgresql_where=sa.text("retention_until IS NOT NULL AND deleted_at IS NULL"),
    )
    op.create_foreign_key(
        "fk_messages_object_metadata",
        "messages",
        "object_metadata",
        ["tenant_id", "object_id"],
        ["tenant_id", "id"],
        source_schema="messaging",
        referent_schema="objects",
        ondelete="RESTRICT",
    )

    op.create_table(
        "flow_definitions",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "channel_capabilities",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("ARRAY[]::text[]"),
        ),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.UniqueConstraint("tenant_id", "id", name="uq_flow_definitions_tenant_id_id"),
        schema="automation",
    )
    op.create_index(
        "uq_flow_definitions_name",
        "flow_definitions",
        ["tenant_id", sa.text("lower(name)")],
        unique=True,
        schema="automation",
    )

    op.create_table(
        "flow_versions",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("flow_definition_id", sa.UUID(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("schema_version", sa.Text(), nullable=False),
        sa.Column("definition", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("validation_status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("validation_errors", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "flow_definition_id"],
            ["automation.flow_definitions.tenant_id", "automation.flow_definitions.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.CheckConstraint("version > 0", name="ck_flow_version_positive"),
        sa.CheckConstraint(
            "validation_status IN ('pending', 'valid', 'invalid')",
            name="ck_flow_version_validation",
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_flow_versions_tenant_id_id"),
        sa.UniqueConstraint("flow_definition_id", "version", name="uq_flow_definition_version"),
        schema="automation",
    )
    op.create_index(
        "ix_flow_versions_published",
        "flow_versions",
        ["tenant_id", "flow_definition_id", sa.text("version DESC")],
        schema="automation",
        postgresql_where=sa.text("published_at IS NOT NULL"),
    )

    op.create_table(
        "flow_runs",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("flow_version_id", sa.UUID(), nullable=False),
        sa.Column("contact_id", sa.UUID(), nullable=True),
        sa.Column("trigger_type", sa.Text(), nullable=False),
        sa.Column(
            "trigger_metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("current_step_key", sa.Text(), nullable=True),
        sa.Column(
            "variables",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("error_safe", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "flow_version_id"],
            ["automation.flow_versions.tenant_id", "automation.flow_versions.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "contact_id"],
            ["crm.contacts.tenant_id", "crm.contacts.id"],
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'running', 'waiting', 'succeeded', "
            "'failed', 'cancelled', 'handed_off')",
            name="ck_flow_run_status",
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_flow_runs_tenant_id_id"),
        schema="automation",
    )
    op.create_index(
        "ix_flow_runs_status_time",
        "flow_runs",
        ["tenant_id", "status", "created_at", "id"],
        schema="automation",
    )
    op.create_index(
        "ix_flow_runs_contact_time",
        "flow_runs",
        ["tenant_id", "contact_id", sa.text("created_at DESC"), sa.text("id DESC")],
        schema="automation",
    )

    op.create_table(
        "flow_step_runs",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("flow_run_id", sa.UUID(), nullable=False),
        sa.Column("step_key", sa.Text(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("input_metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("output_metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("error_safe", sa.Text(), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["tenant_id", "flow_run_id"],
            ["automation.flow_runs.tenant_id", "automation.flow_runs.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint("attempt > 0", name="ck_flow_step_attempt_positive"),
        sa.CheckConstraint(
            "status IN ('running', 'waiting', 'succeeded', 'failed', 'skipped')",
            name="ck_flow_step_status",
        ),
        sa.UniqueConstraint(
            "tenant_id", "flow_run_id", "step_key", "attempt", name="uq_flow_step_attempt"
        ),
        schema="automation",
    )

    op.execute(
        """
        CREATE FUNCTION automation.protect_published_flow_version()
        RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
        BEGIN
          IF OLD.published_at IS NOT NULL THEN
            RAISE EXCEPTION 'published flow versions are immutable' USING ERRCODE = '55000';
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION automation.protect_published_flow_version() FROM PUBLIC")
    op.execute(
        "CREATE TRIGGER trg_protect_published_flow_version "
        "BEFORE UPDATE OR DELETE ON automation.flow_versions "
        "FOR EACH ROW EXECUTE FUNCTION automation.protect_published_flow_version()"
    )

    op.create_table(
        "model_configurations",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("credential_id", sa.UUID(), nullable=True),
        sa.Column(
            "settings",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("daily_request_limit", sa.Integer(), nullable=True),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "credential_id"],
            ["platform.credential_records.tenant_id", "platform.credential_records.id"],
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "daily_request_limit IS NULL OR daily_request_limit > 0", name="ck_model_daily_limit"
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_model_configurations_tenant_id_id"),
        schema="agents",
    )
    op.create_table(
        "knowledge_sources",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("source_type", sa.Text(), nullable=False),
        sa.Column(
            "configuration",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_knowledge_sources_tenant_id_id"),
        schema="agents",
    )
    op.create_table(
        "knowledge_documents",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("source_id", sa.UUID(), nullable=False),
        sa.Column("object_id", sa.UUID(), nullable=True),
        sa.Column("external_id", sa.Text(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("content_checksum", sa.Text(), nullable=False),
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "source_id"],
            ["agents.knowledge_sources.tenant_id", "agents.knowledge_sources.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "object_id"],
            ["objects.object_metadata.tenant_id", "objects.object_metadata.id"],
            ondelete="RESTRICT",
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_knowledge_documents_tenant_id_id"),
        sa.UniqueConstraint(
            "tenant_id", "source_id", "content_checksum", name="uq_knowledge_document_checksum"
        ),
        schema="agents",
    )
    op.create_table(
        "knowledge_chunks",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("document_id", sa.UUID(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=True),
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "search_vector",
            postgresql.TSVECTOR(),
            sa.Computed("to_tsvector('simple'::regconfig, content)", persisted=True),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "document_id"],
            ["agents.knowledge_documents.tenant_id", "agents.knowledge_documents.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint("ordinal >= 0", name="ck_knowledge_chunk_ordinal"),
        sa.CheckConstraint(
            "token_count IS NULL OR token_count >= 0", name="ck_knowledge_chunk_tokens"
        ),
        sa.UniqueConstraint(
            "tenant_id", "document_id", "ordinal", name="uq_knowledge_chunk_ordinal"
        ),
        schema="agents",
    )
    op.create_index(
        "ix_knowledge_chunks_fts",
        "knowledge_chunks",
        ["search_vector"],
        schema="agents",
        postgresql_using="gin",
    )

    op.create_table(
        "usage_events",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("model_configuration_id", sa.UUID(), nullable=True),
        sa.Column("request_kind", sa.Text(), nullable=False),
        sa.Column("input_tokens", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "model_configuration_id"],
            ["agents.model_configurations.tenant_id", "agents.model_configurations.id"],
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "input_tokens >= 0 AND output_tokens >= 0", name="ck_usage_tokens_nonnegative"
        ),
        schema="agents",
    )
    op.create_index(
        "ix_usage_events_tenant_time",
        "usage_events",
        ["tenant_id", sa.text("occurred_at DESC"), sa.text("id DESC")],
        schema="agents",
    )

    op.create_table(
        "inbound_events",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=True),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("provider_account_id", sa.Text(), nullable=False),
        sa.Column("provider_event_id", sa.Text(), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="received"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error_safe", sa.Text(), nullable=True),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.CheckConstraint("version > 0 AND attempts >= 0", name="ck_inbound_event_counters"),
        sa.CheckConstraint(
            "status IN ('received', 'processing', 'processed', 'failed', 'ignored')",
            name="ck_inbound_event_status",
        ),
        sa.UniqueConstraint(
            "provider", "provider_account_id", "provider_event_id", name="uq_inbound_provider_event"
        ),
        schema="ops",
    )
    op.create_index(
        "ix_inbound_events_pending",
        "inbound_events",
        ["status", "received_at", "id"],
        schema="ops",
        postgresql_where=sa.text("status IN ('received', 'failed')"),
    )

    op.create_table(
        "outbox_events",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=True),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("aggregate_type", sa.Text(), nullable=True),
        sa.Column("aggregate_id", sa.UUID(), nullable=True),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "available_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_safe", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.CheckConstraint("version > 0 AND attempts >= 0", name="ck_outbox_event_counters"),
        sa.CheckConstraint(
            "status IN ('pending', 'publishing', 'published', 'failed', 'dead')",
            name="ck_outbox_event_status",
        ),
        schema="ops",
    )
    op.create_index(
        "ix_outbox_events_ready",
        "outbox_events",
        ["status", "available_at", "id"],
        schema="ops",
        postgresql_where=sa.text("status IN ('pending', 'failed')"),
    )

    op.create_table(
        "jobs",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=True),
        sa.Column("queue", sa.Text(), nullable=False),
        sa.Column("job_type", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("reference_type", sa.Text(), nullable=True),
        sa.Column("reference_id", sa.UUID(), nullable=True),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="8"),
        sa.Column(
            "available_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("locked_by", sa.Text(), nullable=True),
        sa.Column("last_error_safe", sa.Text(), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.CheckConstraint(
            "version > 0 AND attempts >= 0 AND max_attempts > 0 AND attempts <= max_attempts",
            name="ck_job_attempts",
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'running', 'retry', 'succeeded', 'dead', 'cancelled')",
            name="ck_job_status",
        ),
        sa.CheckConstraint(
            "status <> 'running' OR (locked_at IS NOT NULL AND locked_by IS NOT NULL)",
            name="ck_job_running_has_lease",
        ),
        schema="ops",
    )
    op.create_index(
        "ix_jobs_claim",
        "jobs",
        ["queue", "status", sa.text("priority DESC"), "available_at", "id"],
        schema="ops",
        postgresql_where=sa.text("status IN ('queued', 'retry', 'running')"),
    )
    op.create_index(
        "uq_jobs_idempotency",
        "jobs",
        [
            sa.text("COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)"),
            "queue",
            "idempotency_key",
        ],
        unique=True,
        schema="ops",
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )

    op.create_table(
        "idempotency_keys",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=True),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("request_hash", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="started"),
        sa.Column("response_metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.CheckConstraint(
            "status IN ('started', 'completed', 'failed')", name="ck_idempotency_status"
        ),
        schema="ops",
    )
    op.create_index(
        "uq_idempotency_scope_key",
        "idempotency_keys",
        [
            sa.text("COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)"),
            "scope",
            "key",
        ],
        unique=True,
        schema="ops",
    )

    op.create_table(
        "import_runs",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("source_system", sa.Text(), nullable=False),
        sa.Column("source_checksum", sa.Text(), nullable=False),
        sa.Column("requested_by_user_id", sa.UUID(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="planned"),
        sa.Column("plan", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["requested_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.CheckConstraint(
            "status IN ('planned', 'running', 'completed', 'failed')", name="ck_import_run_status"
        ),
        sa.UniqueConstraint(
            "tenant_id", "source_system", "source_checksum", name="uq_import_run_source_checksum"
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_import_runs_tenant_id_id"),
        schema="ops",
    )
    op.create_table(
        "import_items",
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("import_run_id", sa.UUID(), nullable=False),
        sa.Column("source_kind", sa.Text(), nullable=False),
        sa.Column("source_id", sa.Text(), nullable=False),
        sa.Column("source_checksum", sa.Text(), nullable=False),
        sa.Column("target_kind", sa.Text(), nullable=True),
        sa.Column("target_id", sa.UUID(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="planned"),
        sa.Column("error_safe", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "import_run_id"],
            ["ops.import_runs.tenant_id", "ops.import_runs.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "status IN ('planned', 'imported', 'skipped', 'failed')", name="ck_import_item_status"
        ),
        sa.PrimaryKeyConstraint("import_run_id", "source_kind", "source_id"),
        schema="ops",
    )
    op.create_index(
        "ix_ops_import_items_tenant_run",
        "import_items",
        ["tenant_id", "import_run_id"],
        schema="ops",
    )

    op.execute(
        """
        CREATE FUNCTION ops.claim_jobs(
          p_worker_id text,
          p_queue text,
          p_limit integer DEFAULT 10,
          p_lease_seconds integer DEFAULT 300
        ) RETURNS SETOF ops.jobs
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          WITH candidates AS (
            SELECT id FROM ops.jobs
            WHERE queue = p_queue
              AND tenant_id = platform.current_tenant_id()
              AND attempts < max_attempts
              AND (
                (status IN ('queued', 'retry') AND available_at <= CURRENT_TIMESTAMP)
                OR (status = 'running' AND locked_at < CURRENT_TIMESTAMP
                    - make_interval(secs => GREATEST(1, p_lease_seconds)))
              )
            ORDER BY priority DESC, available_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT LEAST(GREATEST(p_limit, 1), 100)
          )
          UPDATE ops.jobs AS job
          SET status = 'running', attempts = job.attempts + 1,
              locked_at = CURRENT_TIMESTAMP, locked_by = p_worker_id,
              updated_at = CURRENT_TIMESTAMP
          FROM candidates
          WHERE job.id = candidates.id
          RETURNING job.*
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION ops.claim_jobs(text, text, integer, integer) FROM PUBLIC")
    op.execute(
        "GRANT EXECUTE ON FUNCTION ops.claim_jobs(text, text, integer, integer) "
        "TO platform_worker, platform_messaging"
    )
    op.execute(
        """
        CREATE FUNCTION ops.fail_job(
          p_job_id uuid,
          p_worker_id text,
          p_error_safe text,
          p_retry_delay_seconds integer
        ) RETURNS ops.jobs
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          UPDATE ops.jobs AS job
          SET status = CASE WHEN job.attempts >= job.max_attempts THEN 'dead' ELSE 'retry' END,
              available_at = CASE
                WHEN job.attempts >= job.max_attempts THEN job.available_at
                ELSE CURRENT_TIMESTAMP
                  + make_interval(
                      secs => LEAST(
                        86400.0,
                        GREATEST(p_retry_delay_seconds, 1)
                          * power(2.0, LEAST(GREATEST(job.attempts - 1, 0), 16))
                          + random() * GREATEST(p_retry_delay_seconds, 1)
                      )
                    )
              END,
              locked_at = NULL,
              locked_by = NULL,
              last_error_safe = left(p_error_safe, 2000),
              completed_at = CASE
                WHEN job.attempts >= job.max_attempts THEN CURRENT_TIMESTAMP ELSE NULL
              END,
              updated_at = CURRENT_TIMESTAMP
          WHERE job.id = p_job_id
            AND job.tenant_id = platform.current_tenant_id()
            AND job.status = 'running'
            AND job.locked_by = p_worker_id
          RETURNING job.*
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION ops.fail_job(uuid, text, text, integer) FROM PUBLIC")
    op.execute(
        "GRANT EXECUTE ON FUNCTION ops.fail_job(uuid, text, text, integer) "
        "TO platform_worker, platform_messaging"
    )

    op.create_table(
        "records",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("actor_user_id", sa.UUID(), nullable=True),
        sa.Column("actor_service", sa.Text(), nullable=True),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("target_type", sa.Text(), nullable=False),
        sa.Column("target_id", sa.UUID(), nullable=True),
        sa.Column("request_id", sa.Text(), nullable=True),
        sa.Column("trace_id", sa.Text(), nullable=True),
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.CheckConstraint(
            "actor_user_id IS NOT NULL OR actor_service IS NOT NULL", name="ck_audit_actor"
        ),
        schema="audit",
    )
    op.create_index(
        "ix_audit_records_tenant_cursor",
        "records",
        ["tenant_id", sa.text("occurred_at DESC"), sa.text("id DESC")],
        schema="audit",
    )
    op.create_index(
        "ix_audit_records_target",
        "records",
        ["tenant_id", "target_type", "target_id", sa.text("occurred_at DESC")],
        schema="audit",
    )

    tenant_tables = {
        "objects": ("object_metadata",),
        "automation": ("flow_definitions", "flow_versions", "flow_runs", "flow_step_runs"),
        "agents": (
            "model_configurations",
            "knowledge_sources",
            "knowledge_documents",
            "knowledge_chunks",
            "usage_events",
        ),
        "ops": (
            "inbound_events",
            "outbox_events",
            "jobs",
            "idempotency_keys",
            "import_runs",
            "import_items",
        ),
        "audit": ("records",),
    }
    for schema, tables in tenant_tables.items():
        for table in tables:
            qualified = f'"{schema}"."{table}"'
            op.execute(sa.text(f"ALTER TABLE {qualified} ENABLE ROW LEVEL SECURITY"))
            op.execute(sa.text(f"ALTER TABLE {qualified} FORCE ROW LEVEL SECURITY"))
            if schema == "ops" and table in {
                "inbound_events",
                "outbox_events",
                "jobs",
                "idempotency_keys",
            }:
                predicate = "tenant_id IS NULL OR tenant_id = platform.current_tenant_id()"
            else:
                predicate = "tenant_id = platform.current_tenant_id()"
            op.execute(
                sa.text(
                    f"CREATE POLICY {table}_tenant_isolation ON {qualified} "
                    f"USING ({predicate}) WITH CHECK ({predicate})"
                )
            )

    for schema in ("objects", "automation", "agents", "ops", "audit"):
        for role in ("platform_web", "platform_worker", "platform_readonly"):
            op.execute(sa.text(f'GRANT USAGE ON SCHEMA "{schema}" TO "{role}"'))
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA automation TO platform_web"
    )
    op.execute("GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA objects TO platform_web")
    op.execute("GRANT USAGE ON SCHEMA objects TO platform_messaging, platform_voice")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON objects.object_metadata "
        "TO platform_messaging, platform_voice"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA agents TO platform_web"
    )
    op.execute("GRANT SELECT, INSERT ON audit.records TO platform_web, platform_worker")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON ops.inbound_events, ops.outbox_events, "
        "ops.jobs, ops.idempotency_keys TO platform_worker"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON ops.inbound_events, ops.outbox_events, "
        "ops.jobs, ops.idempotency_keys TO platform_messaging"
    )
    op.execute("GRANT USAGE ON SCHEMA ops TO platform_messaging")
    op.execute(
        "GRANT SELECT ON ALL TABLES IN SCHEMA objects, automation, agents, ops, audit "
        "TO platform_readonly"
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS ops.fail_job(uuid, text, text, integer)")
    op.execute("DROP FUNCTION IF EXISTS ops.claim_jobs(text, text, integer, integer)")
    op.execute(
        "DROP TRIGGER IF EXISTS trg_protect_published_flow_version ON automation.flow_versions"
    )
    op.execute("DROP FUNCTION IF EXISTS automation.protect_published_flow_version()")
    op.drop_table("records", schema="audit")
    for table in (
        "import_items",
        "import_runs",
        "idempotency_keys",
        "jobs",
        "outbox_events",
        "inbound_events",
    ):
        op.drop_table(table, schema="ops")
    for table in (
        "usage_events",
        "knowledge_chunks",
        "knowledge_documents",
        "knowledge_sources",
        "model_configurations",
    ):
        op.drop_table(table, schema="agents")
    for table in ("flow_step_runs", "flow_runs", "flow_versions", "flow_definitions"):
        op.drop_table(table, schema="automation")
    op.drop_constraint(
        "fk_messages_object_metadata", "messages", schema="messaging", type_="foreignkey"
    )
    op.drop_table("object_metadata", schema="objects")
