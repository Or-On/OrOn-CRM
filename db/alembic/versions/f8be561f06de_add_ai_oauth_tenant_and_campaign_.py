"""add ai oauth tenant and campaign billing controls

Revision ID: f8be561f06de
Revises: fad9392c9fb4
Create Date: 2026-09-11 12:38:52.167657
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f8be561f06de"
down_revision: str | None = "fad9392c9fb4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _tenant_policy(schema: str, table: str) -> None:
    qualified = f'"{schema}"."{table}"'
    op.execute(sa.text(f"ALTER TABLE {qualified} ENABLE ROW LEVEL SECURITY"))
    op.execute(sa.text(f"ALTER TABLE {qualified} FORCE ROW LEVEL SECURITY"))
    op.execute(
        sa.text(
            f"CREATE POLICY {table}_tenant_isolation ON {qualified} "
            "USING (tenant_id = platform.current_tenant_id()) "
            "WITH CHECK (tenant_id = platform.current_tenant_id())"
        )
    )


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("ownership_mode", sa.Text(), nullable=False, server_default="human"),
        schema="messaging",
    )
    op.add_column(
        "conversations",
        sa.Column("ai_agent_profile_version_id", sa.UUID(), nullable=True),
        schema="messaging",
    )
    op.add_column(
        "conversations",
        sa.Column("ai_enabled_by_user_id", sa.UUID(), nullable=True),
        schema="messaging",
    )
    op.add_column(
        "conversations",
        sa.Column("ai_enabled_at", sa.DateTime(timezone=True), nullable=True),
        schema="messaging",
    )
    op.add_column(
        "conversations",
        sa.Column("handoff_reason_safe", sa.Text(), nullable=True),
        schema="messaging",
    )
    op.create_check_constraint(
        "ck_conversation_ownership_mode",
        "conversations",
        "ownership_mode IN ('ai','human')",
        schema="messaging",
    )
    op.create_check_constraint(
        "ck_conversation_ai_ownership_shape",
        "conversations",
        "(ownership_mode = 'human') OR "
        "(ai_agent_profile_version_id IS NOT NULL AND ai_enabled_by_user_id IS NOT NULL "
        "AND ai_enabled_at IS NOT NULL)",
        schema="messaging",
    )
    op.create_check_constraint(
        "ck_conversation_handoff_reason_safe",
        "conversations",
        "handoff_reason_safe IS NULL OR length(btrim(handoff_reason_safe)) BETWEEN 1 AND 500",
        schema="messaging",
    )
    op.create_foreign_key(
        "fk_conversation_ai_agent_version",
        "conversations",
        "agent_profile_versions",
        ["tenant_id", "ai_agent_profile_version_id"],
        ["tenant_id", "id"],
        source_schema="messaging",
        referent_schema="agents",
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_conversation_ai_enabled_by",
        "conversations",
        "users",
        ["ai_enabled_by_user_id"],
        ["id"],
        source_schema="messaging",
        ondelete="RESTRICT",
    )
    op.create_index(
        "ix_conversations_ai_ownership",
        "conversations",
        ["tenant_id", "ownership_mode", "updated_at"],
        schema="messaging",
    )

    # OAuth client configuration and refresh tokens are encrypted with
    # AES-256-GCM by the BFF before they cross the database boundary.
    op.execute("GRANT INSERT, UPDATE ON platform.credential_records TO platform_web")
    op.execute("GRANT INSERT ON automation.handoffs TO platform_messaging")

    op.execute("CREATE SCHEMA IF NOT EXISTS billing")
    op.execute("REVOKE ALL ON SCHEMA billing FROM PUBLIC")
    op.execute("GRANT USAGE ON SCHEMA billing TO platform_web, platform_readonly")
    op.create_table(
        "wallets",
        sa.Column(
            "tenant_id",
            sa.UUID(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("available_minor", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("held_minor", sa.BigInteger(), nullable=False, server_default="0"),
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
        sa.CheckConstraint("currency ~ '^[A-Z]{3}$'", name="ck_wallet_currency_iso"),
        sa.CheckConstraint("available_minor >= 0", name="ck_wallet_available_nonnegative"),
        sa.CheckConstraint("held_minor >= 0", name="ck_wallet_held_nonnegative"),
        schema="billing",
    )
    op.create_table(
        "topups",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("requested_by_user_id", sa.UUID(), nullable=False),
        sa.Column("amount_minor", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("provider_session_id", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("failure_code", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["requested_by_user_id"], ["users.id"], ondelete="RESTRICT"),
        sa.CheckConstraint("amount_minor BETWEEN 100 AND 100000000", name="ck_topup_amount"),
        sa.CheckConstraint("currency ~ '^[A-Z]{3}$'", name="ck_topup_currency_iso"),
        sa.CheckConstraint("provider IN ('stripe','simulator')", name="ck_topup_provider"),
        sa.CheckConstraint(
            "status IN ('pending','succeeded','failed','cancelled')",
            name="ck_topup_status",
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_billing_topups_tenant_id_id"),
        sa.UniqueConstraint("tenant_id", "idempotency_key", name="uq_billing_topup_idempotency"),
        schema="billing",
    )
    op.create_index(
        "uq_billing_topup_provider_session",
        "topups",
        ["provider", "provider_session_id"],
        unique=True,
        schema="billing",
        postgresql_where=sa.text("provider_session_id IS NOT NULL"),
    )
    op.create_index(
        "ix_billing_topups_tenant_created",
        "topups",
        ["tenant_id", sa.text("created_at DESC"), sa.text("id DESC")],
        schema="billing",
    )
    op.create_table(
        "ledger_entries",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("topup_id", sa.UUID(), nullable=True),
        sa.Column("entry_type", sa.Text(), nullable=False),
        sa.Column("amount_minor", sa.BigInteger(), nullable=False),
        sa.Column("balance_after_minor", sa.BigInteger(), nullable=False),
        sa.Column("reference", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "topup_id"],
            ["billing.topups.tenant_id", "billing.topups.id"],
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "entry_type IN ('topup','campaign_debit','hold','release','refund')",
            name="ck_ledger_entry_type",
        ),
        sa.CheckConstraint("amount_minor <> 0", name="ck_ledger_amount_nonzero"),
        sa.CheckConstraint("balance_after_minor >= 0", name="ck_ledger_balance_nonnegative"),
        sa.UniqueConstraint("tenant_id", "reference", name="uq_ledger_reference"),
        schema="billing",
    )
    op.create_index(
        "ix_billing_ledger_tenant_created",
        "ledger_entries",
        ["tenant_id", sa.text("created_at DESC"), sa.text("id DESC")],
        schema="billing",
    )
    op.execute(
        """
        INSERT INTO billing.wallets(tenant_id, currency)
        SELECT tenant.id, COALESCE(settings.default_currency, 'USD')
        FROM public.tenants tenant
        LEFT JOIN crm.tenant_settings settings ON settings.tenant_id = tenant.id
        ON CONFLICT (tenant_id) DO NOTHING
        """
    )
    for table in ("wallets", "topups", "ledger_entries"):
        _tenant_policy("billing", table)
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON billing.wallets, billing.topups, "
        "billing.ledger_entries TO platform_web"
    )
    op.execute(
        "GRANT SELECT ON billing.wallets, billing.topups, billing.ledger_entries "
        "TO platform_readonly"
    )

    op.execute(
        """
        CREATE FUNCTION billing.complete_stripe_topup(
          p_tenant_id uuid, p_provider_session_id text, p_amount_minor bigint,
          p_currency text
        ) RETURNS boolean
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, billing
        AS $$
        DECLARE v_topup_id uuid; v_balance bigint;
        BEGIN
          SELECT id INTO v_topup_id
          FROM billing.topups
          WHERE tenant_id = p_tenant_id AND provider = 'stripe'
            AND provider_session_id = p_provider_session_id
            AND amount_minor = p_amount_minor AND currency = upper(p_currency)
          FOR UPDATE;
          IF v_topup_id IS NULL THEN
            RETURN false;
          END IF;
          IF EXISTS (
            SELECT 1 FROM billing.topups
            WHERE id = v_topup_id AND status = 'succeeded'
          ) THEN
            RETURN true;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM billing.topups
            WHERE id = v_topup_id AND status = 'pending'
          ) THEN
            RETURN false;
          END IF;
          INSERT INTO billing.wallets(tenant_id, currency)
          VALUES (p_tenant_id, upper(p_currency))
          ON CONFLICT (tenant_id) DO NOTHING;
          UPDATE billing.wallets
          SET available_minor = available_minor + p_amount_minor,
              updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = p_tenant_id AND currency = upper(p_currency)
          RETURNING available_minor INTO v_balance;
          IF v_balance IS NULL THEN
            RETURN false;
          END IF;
          UPDATE billing.topups SET status = 'succeeded', completed_at = CURRENT_TIMESTAMP
          WHERE id = v_topup_id;
          INSERT INTO billing.ledger_entries(
            tenant_id, topup_id, entry_type, amount_minor,
            balance_after_minor, reference
          ) VALUES (
            p_tenant_id, v_topup_id, 'topup', p_amount_minor,
            v_balance, 'stripe:' || p_provider_session_id
          ) ON CONFLICT (tenant_id, reference) DO NOTHING;
          RETURN true;
        END
        $$
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION billing.complete_stripe_topup(uuid,text,bigint,text) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION "
        "billing.complete_stripe_topup(uuid,text,bigint,text) TO platform_web"
    )

    op.execute(
        """
        CREATE FUNCTION platform.create_tenant_with_defaults(
          p_name text, p_slug text, p_currency text, p_locale text,
          p_timezone text, p_owner_email citext
        ) RETURNS uuid
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, public, platform, crm, billing, audit
        AS $$
        DECLARE v_actor uuid; v_tenant uuid; v_owner uuid;
        BEGIN
          v_actor := nullif(current_setting('app.current_user', true), '')::uuid;
          IF v_actor IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.users WHERE id = v_actor
              AND is_superuser AND status = 'active'
          ) THEN
            RAISE EXCEPTION 'platform administrator required' USING ERRCODE = '42501';
          END IF;
          IF length(btrim(p_name)) NOT BETWEEN 1 AND 120
             OR p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
             OR length(p_slug) > 63
             OR upper(p_currency) !~ '^[A-Z]{3}$'
             OR p_locale NOT IN ('en','he')
             OR length(btrim(p_timezone)) NOT BETWEEN 1 AND 100 THEN
            RAISE EXCEPTION 'invalid tenant configuration' USING ERRCODE = '22023';
          END IF;
          IF p_owner_email IS NOT NULL AND btrim(p_owner_email::text) <> '' THEN
            SELECT id INTO v_owner FROM public.users
            WHERE email = p_owner_email AND status = 'active';
            IF v_owner IS NULL THEN
              RAISE EXCEPTION 'owner account must already exist' USING ERRCODE = '22023';
            END IF;
          END IF;
          INSERT INTO public.tenants(name, slug, status)
          VALUES (btrim(p_name), p_slug, 'active') RETURNING id INTO v_tenant;
          INSERT INTO crm.tenant_settings(
            tenant_id, display_name, default_currency, locale, timezone
          ) VALUES (
            v_tenant, btrim(p_name), upper(p_currency), p_locale, btrim(p_timezone)
          );
          INSERT INTO billing.wallets(tenant_id, currency)
          VALUES (v_tenant, upper(p_currency));
          IF v_owner IS NOT NULL THEN
            INSERT INTO public.memberships(tenant_id, user_id, role)
            VALUES (v_tenant, v_owner, 'owner');
          END IF;
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id, metadata
          ) VALUES (
            v_tenant, v_actor, 'tenant.created', 'tenant', v_tenant,
            jsonb_build_object('slug', p_slug, 'owner_assigned', v_owner IS NOT NULL)
          );
          RETURN v_tenant;
        END
        $$
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION platform.create_tenant_with_defaults"
        "(text,text,text,text,text,citext) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION platform.create_tenant_with_defaults"
        "(text,text,text,text,text,citext) TO platform_web"
    )
    op.execute(
        """
        CREATE FUNCTION platform.list_tenants_for_administrator()
        RETURNS TABLE(
          id uuid, name text, slug text, status text, default_currency text,
          locale text, timezone text, member_count bigint, created_at timestamptz
        )
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, public, platform, crm
        AS $$
          SELECT tenant.id, tenant.name::text, tenant.slug::text, tenant.status::text,
                 settings.default_currency::text, settings.locale::text,
                 settings.timezone::text, count(membership.user_id), tenant.created_at
          FROM public.tenants tenant
          JOIN crm.tenant_settings settings ON settings.tenant_id = tenant.id
          LEFT JOIN public.memberships membership ON membership.tenant_id = tenant.id
          WHERE EXISTS (
            SELECT 1 FROM public.users actor
            WHERE actor.id = nullif(current_setting('app.current_user', true), '')::uuid
              AND actor.is_superuser AND actor.status = 'active'
          )
          GROUP BY tenant.id, settings.default_currency, settings.locale, settings.timezone
          ORDER BY tenant.created_at DESC, tenant.id DESC
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION platform.list_tenants_for_administrator() FROM PUBLIC")
    op.execute(
        "GRANT EXECUTE ON FUNCTION platform.list_tenants_for_administrator() TO platform_web"
    )


def downgrade() -> None:
    op.execute("REVOKE INSERT ON automation.handoffs FROM platform_messaging")
    op.execute("DROP FUNCTION IF EXISTS platform.list_tenants_for_administrator()")
    op.execute(
        "DROP FUNCTION IF EXISTS platform.create_tenant_with_defaults"
        "(text,text,text,text,text,citext)"
    )
    op.execute("DROP FUNCTION IF EXISTS billing.complete_stripe_topup(uuid,text,bigint,text)")
    op.drop_table("ledger_entries", schema="billing")
    op.drop_table("topups", schema="billing")
    op.drop_table("wallets", schema="billing")
    op.execute("DROP SCHEMA IF EXISTS billing")
    op.execute("REVOKE INSERT, UPDATE ON platform.credential_records FROM platform_web")
    op.drop_index("ix_conversations_ai_ownership", table_name="conversations", schema="messaging")
    op.drop_constraint(
        "fk_conversation_ai_enabled_by",
        "conversations",
        schema="messaging",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_conversation_ai_agent_version",
        "conversations",
        schema="messaging",
        type_="foreignkey",
    )
    op.drop_constraint(
        "ck_conversation_handoff_reason_safe",
        "conversations",
        schema="messaging",
        type_="check",
    )
    op.drop_constraint(
        "ck_conversation_ai_ownership_shape",
        "conversations",
        schema="messaging",
        type_="check",
    )
    op.drop_constraint(
        "ck_conversation_ownership_mode",
        "conversations",
        schema="messaging",
        type_="check",
    )
    for column in (
        "handoff_reason_safe",
        "ai_enabled_at",
        "ai_enabled_by_user_id",
        "ai_agent_profile_version_id",
        "ownership_mode",
    ):
        op.drop_column("conversations", column, schema="messaging")
