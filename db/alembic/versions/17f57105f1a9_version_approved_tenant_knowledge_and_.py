"""version approved tenant knowledge and protect publication

Revision ID: 17f57105f1a9
Revises: bfb741c767fd
Create Date: 2026-09-12 21:50:14.131759
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "17f57105f1a9"
down_revision: str | None = "bfb741c767fd"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("knowledge_documents", sa.Column("version", sa.Integer()), schema="agents")
    op.execute("""
        WITH numbered AS (
          SELECT id,row_number() OVER (PARTITION BY tenant_id,source_id ORDER BY created_at,id) AS n
          FROM agents.knowledge_documents
        ) UPDATE agents.knowledge_documents d SET version=n.n FROM numbered n WHERE d.id=n.id
    """)
    op.alter_column("knowledge_documents", "version", nullable=False, schema="agents")
    for column in ("published_at", "valid_until", "revoked_at"):
        op.add_column(
            "knowledge_documents", sa.Column(column, sa.DateTime(timezone=True)), schema="agents"
        )
    op.add_column(
        "knowledge_documents",
        sa.Column(
            "valid_from",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        schema="agents",
    )
    op.create_unique_constraint(
        "uq_knowledge_source_version",
        "knowledge_documents",
        ["tenant_id", "source_id", "version"],
        schema="agents",
    )
    op.create_check_constraint(
        "ck_knowledge_version_positive", "knowledge_documents", "version > 0", schema="agents"
    )
    op.create_check_constraint(
        "ck_knowledge_validity",
        "knowledge_documents",
        "valid_until IS NULL OR valid_until > valid_from",
        schema="agents",
    )
    op.create_check_constraint(
        "ck_knowledge_revoked_published",
        "knowledge_documents",
        "revoked_at IS NULL OR published_at IS NOT NULL",
        schema="agents",
    )
    op.execute("""
        CREATE FUNCTION agents.protect_approved_knowledge() RETURNS trigger
        LANGUAGE plpgsql SET search_path=pg_catalog AS $$
        BEGIN
          IF current_user='platform_web' AND NOT platform.canonical_actor_authorized() THEN
            RAISE EXCEPTION 'knowledge management requires an active manager' USING ERRCODE='42501';
          END IF;
          IF TG_TABLE_NAME='knowledge_documents' THEN
            IF TG_OP='INSERT' AND NEW.version IS NULL THEN
              -- Preserve existing unpublished manual-import/FTS writers.
              PERFORM 1 FROM agents.knowledge_sources WHERE id=NEW.source_id FOR UPDATE;
              SELECT COALESCE(MAX(version),0)+1 INTO NEW.version
                FROM agents.knowledge_documents WHERE source_id=NEW.source_id;
            END IF;
            IF TG_OP<>'INSERT' AND OLD.published_at IS NOT NULL THEN
              IF TG_OP='UPDATE' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
                 AND (to_jsonb(NEW)-'revoked_at')=(to_jsonb(OLD)-'revoked_at') THEN
                RETURN NEW;
              END IF;
              RAISE EXCEPTION 'published knowledge is immutable; revoke or publish a new version'
                USING ERRCODE='55000';
            END IF;
          ELSIF TG_TABLE_NAME='knowledge_chunks' THEN
            IF TG_OP<>'INSERT' THEN
              PERFORM 1 FROM agents.knowledge_documents
                WHERE id=OLD.document_id AND published_at IS NOT NULL;
              IF FOUND THEN
                RAISE EXCEPTION 'published knowledge chunks are immutable' USING ERRCODE='55000';
              END IF;
            END IF;
            IF TG_OP<>'DELETE' THEN
              PERFORM 1 FROM agents.knowledge_documents
                WHERE id=NEW.document_id AND published_at IS NOT NULL;
              IF FOUND THEN
                RAISE EXCEPTION 'published knowledge chunks are immutable' USING ERRCODE='55000';
              END IF;
            END IF;
          END IF;
          RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
        END $$
    """)
    op.execute("REVOKE ALL ON FUNCTION agents.protect_approved_knowledge() FROM PUBLIC")
    for table in ("knowledge_sources", "knowledge_documents", "knowledge_chunks"):
        op.execute(
            "CREATE TRIGGER trg_protect_approved_knowledge BEFORE INSERT OR UPDATE OR DELETE "
            f"ON agents.{table} FOR EACH ROW "
            "EXECUTE FUNCTION agents.protect_approved_knowledge()"
        )
    # Existing tenant RLS applies before either runtime can retrieve knowledge.
    op.execute("""
        CREATE FUNCTION platform.current_tenant_active() RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
          SELECT EXISTS (
            SELECT 1 FROM public.tenants
            WHERE id=platform.current_tenant_id() AND status='active'
          )
        $$
    """)
    op.execute("REVOKE ALL ON FUNCTION platform.current_tenant_active() FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION platform.current_tenant_active() TO platform_voice")
    op.execute("GRANT EXECUTE ON FUNCTION platform.canonical_actor_authorized() TO platform_voice")
    op.execute("GRANT USAGE ON SCHEMA agents TO platform_voice,platform_messaging")
    op.execute(
        "GRANT SELECT ON agents.knowledge_sources,agents.knowledge_documents,"
        "agents.knowledge_chunks "
        "TO platform_voice,platform_messaging"
    )


def downgrade() -> None:
    op.execute("""
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM agents.knowledge_documents WHERE published_at IS NOT NULL) THEN
            RAISE EXCEPTION 'published knowledge provenance requires backup and forward recovery'
              USING ERRCODE='55000';
          END IF;
        END $$
    """)
    op.execute("DROP FUNCTION platform.current_tenant_active()")
    op.execute(
        "REVOKE EXECUTE ON FUNCTION platform.canonical_actor_authorized() FROM platform_voice"
    )
    op.execute(
        "REVOKE SELECT ON agents.knowledge_sources,agents.knowledge_documents,"
        "agents.knowledge_chunks "
        "FROM platform_voice,platform_messaging"
    )
    for table in ("knowledge_sources", "knowledge_documents", "knowledge_chunks"):
        op.execute(f"DROP TRIGGER trg_protect_approved_knowledge ON agents.{table}")
    op.execute("DROP FUNCTION agents.protect_approved_knowledge()")
    for constraint in (
        "ck_knowledge_revoked_published",
        "ck_knowledge_validity",
        "ck_knowledge_version_positive",
        "uq_knowledge_source_version",
    ):
        op.drop_constraint(constraint, "knowledge_documents", schema="agents")
    for column in ("version", "published_at", "valid_from", "valid_until", "revoked_at"):
        op.drop_column("knowledge_documents", column, schema="agents")
