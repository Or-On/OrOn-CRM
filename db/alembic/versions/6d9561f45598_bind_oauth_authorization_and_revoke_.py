"""bind oauth authorization and revoke inactive tenant keys

Revision ID: 6d9561f45598
Revises: 2b2b64433c98
Create Date: 2026-09-12 19:44:06.004622
"""

from collections.abc import Sequence

from alembic import op

revision: str = "6d9561f45598"
down_revision: str | None = "2b2b64433c98"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE OR REPLACE FUNCTION platform.resolve_api_key(p_hashed_key text)
        RETURNS TABLE(resolved_tenant_id uuid, resolved_scopes text[])
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
        DECLARE v_tenant uuid;
        BEGIN
          -- Same lock order as tenant deletion. Caller keeps this transaction open
          -- until its authorized operation commits, preventing deletion TOCTOU.
          SELECT tenant.id INTO v_tenant
          FROM public.tenants tenant JOIN public.api_keys key ON key.tenant_id=tenant.id
          WHERE key.hashed_key=p_hashed_key AND tenant.status='active'
          FOR SHARE OF tenant;
          IF v_tenant IS NULL THEN RETURN; END IF;
          RETURN QUERY UPDATE public.api_keys AS key
          SET last_used_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
          WHERE key.hashed_key=p_hashed_key AND key.tenant_id=v_tenant
            AND key.status='active' AND key.revoked_at IS NULL
            AND (key.expires_at IS NULL OR key.expires_at>CURRENT_TIMESTAMP)
          RETURNING key.tenant_id, key.scopes;
        END $$;
    """)
    op.execute("REVOKE ALL ON FUNCTION platform.resolve_api_key(text) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION platform.resolve_api_key(text) TO platform_web")
    op.execute("""
        CREATE FUNCTION platform.revoke_inactive_tenant_keys()
        RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
        BEGIN
          IF NEW.status <> 'active' THEN
            UPDATE public.api_keys SET status='revoked', revoked_at=CURRENT_TIMESTAMP,
              updated_at=CURRENT_TIMESTAMP WHERE tenant_id=NEW.id AND status='active';
          END IF;
          RETURN NEW;
        END $$;
    """)
    op.execute("REVOKE ALL ON FUNCTION platform.revoke_inactive_tenant_keys() FROM PUBLIC")
    op.execute("""
        CREATE TRIGGER revoke_inactive_tenant_keys AFTER UPDATE OF status ON public.tenants
        FOR EACH ROW EXECUTE FUNCTION platform.revoke_inactive_tenant_keys();
    """)
    op.execute("""
        UPDATE public.api_keys key SET status='revoked', revoked_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP FROM public.tenants tenant
          WHERE key.tenant_id=tenant.id AND tenant.status <> 'active' AND key.status='active';
    """)
    op.execute("""
        CREATE TABLE platform.oauth_authorizations (
          state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          session_id uuid NOT NULL REFERENCES platform.auth_sessions(id) ON DELETE CASCADE,
          provider text NOT NULL CHECK (provider IN ('google','microsoft')),
          redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2048),
          expires_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP + interval '10 minutes',
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          consumed_at timestamptz,
          CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
        );
    """)
    op.execute(
        "CREATE INDEX oauth_authorizations_expiry ON platform.oauth_authorizations(expires_at)"
    )
    op.execute("ALTER TABLE platform.oauth_authorizations ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE platform.oauth_authorizations FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY oauth_authorizations_owner ON platform.oauth_authorizations
          USING (tenant_id=platform.current_tenant_id() AND user_id=platform.current_user_id())
          WITH CHECK (
            tenant_id=platform.current_tenant_id() AND user_id=platform.current_user_id()
          );
    """)
    op.execute("REVOKE ALL ON platform.oauth_authorizations FROM PUBLIC")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON platform.oauth_authorizations TO platform_web"
    )


def downgrade() -> None:
    # Revoked keys remain revoked. An image rollback must not re-enable credentials.
    op.execute("DROP TABLE platform.oauth_authorizations")
    op.execute("DROP TRIGGER revoke_inactive_tenant_keys ON public.tenants")
    op.execute("DROP FUNCTION platform.revoke_inactive_tenant_keys()")
    # Keep the security guard on downgrade: old callers accept the same signature.
