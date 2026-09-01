"""add scoped public API keys

Revision ID: b56eb0a0aca1
Revises: 66e34e3b2067
Create Date: 2026-09-01 22:57:12.022705
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b56eb0a0aca1"
down_revision: str | None = "66e34e3b2067"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "api_keys", sa.Column("name", sa.Text(), nullable=False, server_default="Legacy key")
    )
    op.add_column(
        "api_keys", sa.Column("prefix", sa.Text(), nullable=False, server_default="legacy")
    )
    op.add_column(
        "api_keys",
        sa.Column(
            "scopes",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("ARRAY['crm:read']::text[]"),
        ),
    )
    op.add_column("api_keys", sa.Column("created_by_user_id", sa.UUID(), nullable=True))
    op.add_column("api_keys", sa.Column("last_used_at", sa.DateTime(timezone=True)))
    op.add_column("api_keys", sa.Column("expires_at", sa.DateTime(timezone=True)))
    op.add_column("api_keys", sa.Column("revoked_at", sa.DateTime(timezone=True)))
    op.create_foreign_key(
        "fk_api_keys_created_by_user",
        "api_keys",
        "users",
        ["created_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_check_constraint(
        "ck_api_key_scope_count", "api_keys", "cardinality(scopes) BETWEEN 1 AND 20"
    )
    op.create_check_constraint(
        "ck_api_key_lifecycle",
        "api_keys",
        "(status = 'active' AND revoked_at IS NULL) OR "
        "(status = 'revoked' AND revoked_at IS NOT NULL)",
    )
    op.execute("ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE public.api_keys FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY api_keys_tenant_isolation ON public.api_keys "
        "USING (tenant_id = platform.current_tenant_id()) "
        "WITH CHECK (tenant_id = platform.current_tenant_id())"
    )
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO platform_web")
    op.execute(
        """
        CREATE FUNCTION platform.resolve_api_key(p_hashed_key text)
        RETURNS TABLE(resolved_tenant_id uuid, resolved_scopes text[])
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          UPDATE public.api_keys AS key
          SET last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE key.hashed_key = p_hashed_key
            AND key.tenant_id IS NOT NULL
            AND key.status = 'active' AND key.revoked_at IS NULL
            AND (key.expires_at IS NULL OR key.expires_at > CURRENT_TIMESTAMP)
          RETURNING key.tenant_id, key.scopes
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION platform.resolve_api_key(text) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION platform.resolve_api_key(text) TO platform_web")


def downgrade() -> None:
    op.execute("DROP FUNCTION platform.resolve_api_key(text)")
    op.execute("REVOKE SELECT, INSERT, UPDATE, DELETE ON api_keys FROM platform_web")
    op.execute("DROP POLICY api_keys_tenant_isolation ON public.api_keys")
    op.execute("ALTER TABLE public.api_keys NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE public.api_keys DISABLE ROW LEVEL SECURITY")
    op.drop_constraint("ck_api_key_lifecycle", "api_keys", type_="check")
    op.drop_constraint("ck_api_key_scope_count", "api_keys", type_="check")
    op.drop_constraint("fk_api_keys_created_by_user", "api_keys", type_="foreignkey")
    op.drop_column("api_keys", "revoked_at")
    op.drop_column("api_keys", "expires_at")
    op.drop_column("api_keys", "last_used_at")
    op.drop_column("api_keys", "created_by_user_id")
    op.drop_column("api_keys", "scopes")
    op.drop_column("api_keys", "prefix")
    op.drop_column("api_keys", "name")
