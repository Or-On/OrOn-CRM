"""bind billing provider events to expected checkout records

Revision ID: 74e4f347dbbd
Revises: 6d9561f45598
Create Date: 2026-09-12 19:50:18.507295
"""

from collections.abc import Sequence

from alembic import op

revision: str = "74e4f347dbbd"
down_revision: str | None = "6d9561f45598"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE billing.topups ADD COLUMN expected_customer_id text
    """)
    op.execute("""
        ALTER TABLE billing.topups ADD CONSTRAINT ck_topup_expected_customer
          CHECK (expected_customer_id IS NULL OR expected_customer_id ~ '^cus_[A-Za-z0-9]+$')
    """)
    op.execute("""
        CREATE TABLE billing.payment_setup_requests (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
          requested_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
          expected_customer_id text NOT NULL CHECK (expected_customer_id ~ '^cus_[A-Za-z0-9]+$'),
          idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
          provider_session_id text UNIQUE,
          setup_intent_id text UNIQUE,
          status text NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','succeeded','superseded')),
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at timestamptz,
          UNIQUE (tenant_id,id), UNIQUE (tenant_id,idempotency_key),
          CHECK (provider_session_id IS NULL OR provider_session_id ~ '^cs_[A-Za-z0-9_]+$')
        )
    """)
    op.execute("""
        ALTER TABLE billing.payment_setup_requests ENABLE ROW LEVEL SECURITY
    """)
    op.execute("""
        ALTER TABLE billing.payment_setup_requests FORCE ROW LEVEL SECURITY
    """)
    op.execute("""
        CREATE POLICY payment_setup_requests_tenant_isolation ON billing.payment_setup_requests
          USING (tenant_id = platform.current_tenant_id())
          WITH CHECK (tenant_id = platform.current_tenant_id())
    """)
    op.execute("""
        GRANT SELECT,INSERT ON billing.payment_setup_requests TO platform_web
    """)
    op.execute("""
        GRANT UPDATE (idempotency_key,provider_session_id)
          ON billing.payment_setup_requests TO platform_web
    """)
    op.execute("""
        -- Runtime money mutation is function-only; existing wallet initialization
        -- may insert defaults and perform its no-op currency upsert, not mint funds.
        REVOKE INSERT,UPDATE ON billing.wallets,billing.ledger_entries,billing.topups
          FROM platform_web
    """)
    op.execute("""
        GRANT INSERT (tenant_id,currency), UPDATE (currency) ON billing.wallets TO platform_web
    """)
    op.execute("""
        GRANT INSERT (tenant_id,requested_by_user_id,amount_minor,currency,
          provider,idempotency_key,expected_customer_id),
          UPDATE (provider_session_id,idempotency_key) ON billing.topups TO platform_web
    """)
    op.execute("""
        -- Old application images fail closed rather than use the unbound contract.
        REVOKE EXECUTE ON FUNCTION billing.complete_stripe_topup(uuid,text,bigint,text)
          FROM platform_web
    """)
    op.execute("""
        REVOKE EXECUTE ON FUNCTION billing.record_stripe_payment_source
          (uuid,text,text,text,text,integer,integer) FROM platform_web
    """)
    op.execute("""
        CREATE FUNCTION billing.complete_stripe_topup(
          p_tenant_id uuid,p_topup_id uuid,p_session_id text,p_customer_id text,
          p_amount_minor bigint,p_currency text
        ) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
        DECLARE v_topup billing.topups%ROWTYPE; v_balance bigint;
        BEGIN
          SELECT * INTO v_topup FROM billing.topups
          WHERE tenant_id=p_tenant_id AND id=p_topup_id AND provider='stripe'
            AND provider_session_id=p_session_id AND expected_customer_id=p_customer_id
            AND amount_minor=p_amount_minor AND currency=upper(p_currency)
          FOR UPDATE;
          IF NOT FOUND THEN RETURN false; END IF;
          IF v_topup.status='succeeded' THEN RETURN true; END IF;
          IF v_topup.status<>'pending' THEN RETURN false; END IF;
          UPDATE billing.wallets SET available_minor=available_minor+p_amount_minor,
            updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=p_tenant_id AND currency=upper(p_currency)
          RETURNING available_minor INTO v_balance;
          IF v_balance IS NULL THEN RETURN false; END IF;
          UPDATE billing.topups SET status='succeeded',completed_at=CURRENT_TIMESTAMP
          WHERE id=p_topup_id;
          INSERT INTO billing.ledger_entries
            (tenant_id,topup_id,entry_type,amount_minor,balance_after_minor,reference)
          VALUES(p_tenant_id,p_topup_id,'topup',p_amount_minor,v_balance,'stripe:'||p_session_id);
          INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,metadata)
          VALUES(p_tenant_id,v_topup.requested_by_user_id,
            'billing.topup.completed','billing_topup',p_topup_id,
            jsonb_build_object('amount_minor',p_amount_minor,'currency',upper(p_currency)));
          RETURN true;
        END $$
    """)
    op.execute("""
        REVOKE ALL ON FUNCTION billing.complete_stripe_topup
          (uuid,uuid,text,text,bigint,text) FROM PUBLIC
    """)
    op.execute("""
        GRANT EXECUTE ON FUNCTION billing.complete_stripe_topup
          (uuid,uuid,text,text,bigint,text) TO platform_web
    """)
    op.execute("""
        CREATE FUNCTION billing.expected_stripe_setup(
          p_tenant_id uuid,p_request_id uuid,p_session_id text,p_customer_id text
        ) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
          SELECT EXISTS(
            SELECT 1 FROM billing.payment_setup_requests request
            JOIN billing.payment_profiles profile ON profile.tenant_id=request.tenant_id
            WHERE request.tenant_id=p_tenant_id AND request.id=p_request_id
              AND request.provider_session_id=p_session_id
              AND request.expected_customer_id=p_customer_id
              AND profile.stripe_customer_id=p_customer_id
          )
        $$
    """)
    op.execute("""
        REVOKE ALL ON FUNCTION billing.expected_stripe_setup(uuid,uuid,text,text) FROM PUBLIC
    """)
    op.execute("""
        GRANT EXECUTE ON FUNCTION billing.expected_stripe_setup(uuid,uuid,text,text) TO platform_web
    """)
    op.execute("""
        CREATE FUNCTION billing.record_stripe_payment_source(
          p_tenant_id uuid,p_request_id uuid,p_session_id text,p_customer_id text,
          p_setup_intent_id text,
          p_payment_method_id text,p_brand text,p_last4 text,p_exp_month integer,p_exp_year integer
        ) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
        DECLARE v_request billing.payment_setup_requests%ROWTYPE;
        BEGIN
          IF p_setup_intent_id IS NULL OR p_payment_method_id IS NULL OR p_brand IS NULL
             OR p_last4 IS NULL OR p_exp_month IS NULL OR p_exp_year IS NULL
             OR p_setup_intent_id !~ '^seti_[A-Za-z0-9]+$'
             OR p_payment_method_id !~ '^pm_[A-Za-z0-9]+$'
             OR length(btrim(p_brand)) NOT BETWEEN 1 AND 32 OR p_last4 !~ '^[0-9]{4}$'
             OR p_exp_month NOT BETWEEN 1 AND 12 OR p_exp_year NOT BETWEEN 2020 AND 2200 THEN
            RETURN false;
          END IF;
          -- Serialize replacement of a tenant's card to make out-of-order setup
          -- completion deterministic; an older request cannot replace a newer one.
          PERFORM 1 FROM billing.payment_profiles
          WHERE tenant_id=p_tenant_id AND stripe_customer_id=p_customer_id FOR UPDATE;
          IF NOT FOUND THEN RETURN false; END IF;
          SELECT * INTO v_request FROM billing.payment_setup_requests
          WHERE tenant_id=p_tenant_id AND id=p_request_id AND provider_session_id=p_session_id
            AND expected_customer_id=p_customer_id FOR UPDATE;
          IF NOT FOUND THEN RETURN false; END IF;
          IF v_request.status IN ('succeeded','superseded') THEN
            RETURN v_request.setup_intent_id=p_setup_intent_id;
          END IF;
          IF EXISTS(SELECT 1 FROM billing.payment_setup_requests
            WHERE tenant_id=p_tenant_id AND status='succeeded'
              AND (created_at,id)>(v_request.created_at,v_request.id)) THEN
            UPDATE billing.payment_setup_requests
              SET status='superseded',setup_intent_id=p_setup_intent_id,
              completed_at=CURRENT_TIMESTAMP WHERE id=p_request_id;
            RETURN true;
          END IF;
          UPDATE billing.payment_profiles SET stripe_payment_method_id=p_payment_method_id,
            brand=lower(btrim(p_brand)),last4=p_last4,exp_month=p_exp_month,exp_year=p_exp_year,
            status='active',updated_at=CURRENT_TIMESTAMP WHERE tenant_id=p_tenant_id;
          UPDATE billing.payment_setup_requests
            SET status='succeeded',setup_intent_id=p_setup_intent_id,
            completed_at=CURRENT_TIMESTAMP WHERE id=p_request_id;
          INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,metadata)
          VALUES(p_tenant_id,v_request.requested_by_user_id,'billing.payment_source.connected',
            'payment_setup_request',p_request_id,'{}'::jsonb);
          RETURN true;
        END $$
    """)
    op.execute("""
        REVOKE ALL ON FUNCTION billing.record_stripe_payment_source
          (uuid,uuid,text,text,text,text,text,text,integer,integer) FROM PUBLIC
    """)
    op.execute("""
        GRANT EXECUTE ON FUNCTION billing.record_stripe_payment_source
          (uuid,uuid,text,text,text,text,text,text,integer,integer) TO platform_web
    """)


def downgrade() -> None:
    # Only an unused billing successor can be safely removed. Never erase provider
    # recovery evidence. Populated environments use restore-to-new-database.
    op.execute("""
        DO $$ BEGIN
          LOCK TABLE billing.topups,billing.payment_setup_requests IN ACCESS EXCLUSIVE MODE;
          IF EXISTS(SELECT 1 FROM billing.topups WHERE expected_customer_id IS NOT NULL)
             OR EXISTS(SELECT 1 FROM billing.payment_setup_requests) THEN
            RAISE EXCEPTION 'Billing binding data exists; restore to a new database after review';
          END IF;
        END $$
    """)
    op.execute("DROP FUNCTION billing.expected_stripe_setup(uuid,uuid,text,text)")
    op.execute("DROP FUNCTION billing.complete_stripe_topup(uuid,uuid,text,text,bigint,text)")
    op.execute("""
        DROP FUNCTION billing.record_stripe_payment_source
          (uuid,uuid,text,text,text,text,text,text,integer,integer)
    """)
    op.execute("DROP TABLE billing.payment_setup_requests")
    op.execute("ALTER TABLE billing.topups DROP COLUMN expected_customer_id")
    op.execute("""
        GRANT INSERT,UPDATE ON billing.wallets,billing.ledger_entries,billing.topups TO platform_web
    """)
    op.execute("""
        GRANT EXECUTE ON FUNCTION billing.complete_stripe_topup(uuid,text,bigint,text)
          TO platform_web
    """)
    op.execute("""
        GRANT EXECUTE ON FUNCTION billing.record_stripe_payment_source
          (uuid,text,text,text,text,integer,integer) TO platform_web
    """)
