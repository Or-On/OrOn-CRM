"""require Stripe payment sources

Revision ID: d41b2038c77a
Revises: ac18e9d47b20
Create Date: 2026-09-11 15:03:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d41b2038c77a"
down_revision: str | None = "ac18e9d47b20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "payment_profiles",
        sa.Column(
            "tenant_id",
            sa.UUID(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("stripe_customer_id", sa.Text(), nullable=False, unique=True),
        sa.Column("stripe_payment_method_id", sa.Text(), nullable=True, unique=True),
        sa.Column("brand", sa.Text(), nullable=True),
        sa.Column("last4", sa.String(length=4), nullable=True),
        sa.Column("exp_month", sa.SmallInteger(), nullable=True),
        sa.Column("exp_year", sa.SmallInteger(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
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
        sa.CheckConstraint("status IN ('pending','active')", name="ck_payment_profile_status"),
        sa.CheckConstraint(
            "(status = 'pending' AND stripe_payment_method_id IS NULL) OR "
            "(status = 'active' AND stripe_payment_method_id IS NOT NULL "
            "AND brand IS NOT NULL AND last4 ~ '^[0-9]{4}$' "
            "AND exp_month BETWEEN 1 AND 12 AND exp_year >= 2020)",
            name="ck_payment_profile_card_shape",
        ),
        schema="billing",
    )
    op.execute("ALTER TABLE billing.payment_profiles ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE billing.payment_profiles FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY payment_profiles_tenant_isolation
        ON billing.payment_profiles
        USING (tenant_id = platform.current_tenant_id())
        WITH CHECK (tenant_id = platform.current_tenant_id())
        """
    )
    op.execute("GRANT SELECT, INSERT, UPDATE ON billing.payment_profiles TO platform_web")
    op.execute("GRANT SELECT ON billing.payment_profiles TO platform_readonly")

    op.execute(
        """
        CREATE FUNCTION billing.record_stripe_payment_source(
          p_tenant_id uuid, p_customer_id text, p_payment_method_id text,
          p_brand text, p_last4 text, p_exp_month integer, p_exp_year integer
        ) RETURNS boolean
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, public, billing
        AS $$
        BEGIN
          IF p_customer_id !~ '^cus_[A-Za-z0-9]+$'
             OR p_payment_method_id !~ '^pm_[A-Za-z0-9]+$'
             OR length(btrim(p_brand)) NOT BETWEEN 1 AND 32
             OR p_last4 !~ '^[0-9]{4}$'
             OR p_exp_month NOT BETWEEN 1 AND 12
             OR p_exp_year < 2020 THEN
            RETURN false;
          END IF;
          IF EXISTS (
            SELECT 1 FROM billing.payment_profiles
            WHERE tenant_id = p_tenant_id AND stripe_customer_id <> p_customer_id
          ) THEN
            RETURN false;
          END IF;
          INSERT INTO billing.payment_profiles(
            tenant_id, stripe_customer_id, stripe_payment_method_id,
            brand, last4, exp_month, exp_year, status
          ) VALUES (
            p_tenant_id, p_customer_id, p_payment_method_id,
            lower(btrim(p_brand)), p_last4, p_exp_month, p_exp_year, 'active'
          )
          ON CONFLICT (tenant_id) DO UPDATE SET
            stripe_payment_method_id = EXCLUDED.stripe_payment_method_id,
            brand = EXCLUDED.brand,
            last4 = EXCLUDED.last4,
            exp_month = EXCLUDED.exp_month,
            exp_year = EXCLUDED.exp_year,
            status = 'active',
            updated_at = CURRENT_TIMESTAMP;
          RETURN true;
        END
        $$
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION billing.record_stripe_payment_source"
        "(uuid,text,text,text,text,integer,integer) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION billing.record_stripe_payment_source"
        "(uuid,text,text,text,text,integer,integer) TO platform_web"
    )

    # Remove every balance contribution created by the old local simulator,
    # while preserving any real Stripe-funded amount in the same wallet.
    op.execute(
        """
        WITH simulated AS (
          SELECT tenant_id, sum(amount_minor)::bigint AS amount_minor
          FROM billing.topups
          WHERE provider = 'simulator' AND status = 'succeeded'
          GROUP BY tenant_id
        )
        UPDATE billing.wallets wallet
        SET available_minor = greatest(
              wallet.available_minor - simulated.amount_minor, 0
            ),
            updated_at = CURRENT_TIMESTAMP
        FROM simulated
        WHERE wallet.tenant_id = simulated.tenant_id
        """
    )
    op.execute(
        """
        DELETE FROM billing.ledger_entries entry
        USING billing.topups topup
        WHERE entry.topup_id = topup.id AND topup.provider = 'simulator'
        """
    )
    op.execute("DELETE FROM billing.topups WHERE provider = 'simulator'")
    op.drop_constraint("ck_topup_provider", "topups", schema="billing", type_="check")
    op.create_check_constraint(
        "ck_topup_provider", "topups", "provider = 'stripe'", schema="billing"
    )


def downgrade() -> None:
    op.drop_constraint("ck_topup_provider", "topups", schema="billing", type_="check")
    op.create_check_constraint(
        "ck_topup_provider",
        "topups",
        "provider IN ('stripe','simulator')",
        schema="billing",
    )
    op.execute(
        "DROP FUNCTION IF EXISTS billing.record_stripe_payment_source"
        "(uuid,text,text,text,text,integer,integer)"
    )
    op.drop_table("payment_profiles", schema="billing")
    # Removed simulator credits cannot be reconstructed safely.
