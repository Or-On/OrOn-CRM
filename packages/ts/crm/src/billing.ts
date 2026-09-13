import type postgres from "postgres";

export interface CampaignWallet {
  readonly currency: string;
  readonly availableMinor: number;
  readonly heldMinor: number;
}
export interface CampaignTopup {
  readonly id: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly provider: "stripe";
  readonly status: string;
  readonly createdAt: string;
}

export interface CampaignPaymentSource {
  readonly status: "pending" | "active";
  readonly brand: string | null;
  readonly last4: string | null;
  readonly expMonth: number | null;
  readonly expYear: number | null;
}

export interface StripeBillingProfile extends CampaignPaymentSource {
  readonly stripeCustomerId: string;
  readonly stripePaymentMethodId: string | null;
}

export async function getCampaignWallet(
  sql: postgres.TransactionSql,
): Promise<CampaignWallet> {
  const rows = await sql<
    { currency: string; available_minor: string; held_minor: string }[]
  >`
    INSERT INTO billing.wallets(tenant_id, currency)
    SELECT platform.current_tenant_id(), settings.default_currency
    FROM crm.tenant_settings settings
    WHERE settings.tenant_id=platform.current_tenant_id()
    ON CONFLICT (tenant_id) DO UPDATE SET currency=billing.wallets.currency
    RETURNING currency, available_minor, held_minor
  `;
  const row = rows[0];
  if (!row) throw new Error("Campaign wallet is unavailable");
  return {
    currency: row.currency,
    availableMinor: Number(row.available_minor),
    heldMinor: Number(row.held_minor),
  };
}

export async function listCampaignTopups(
  sql: postgres.TransactionSql,
): Promise<readonly CampaignTopup[]> {
  const rows = await sql<
    {
      id: string;
      amount_minor: string;
      currency: string;
      provider: "stripe";
      status: string;
      created_at: Date;
    }[]
  >`
    SELECT id, amount_minor, currency, provider, status, created_at
    FROM billing.topups ORDER BY created_at DESC, id DESC LIMIT 20
  `;
  return rows.map((row) => ({
    id: row.id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    provider: row.provider,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function getStripeBillingProfile(
  sql: postgres.TransactionSql,
): Promise<StripeBillingProfile | null> {
  const rows = await sql<
    {
      stripe_customer_id: string;
      stripe_payment_method_id: string | null;
      status: "pending" | "active";
      brand: string | null;
      last4: string | null;
      exp_month: number | null;
      exp_year: number | null;
    }[]
  >`
    SELECT stripe_customer_id, stripe_payment_method_id, status,
           brand, last4, exp_month, exp_year
    FROM billing.payment_profiles
    WHERE tenant_id=platform.current_tenant_id()
  `;
  const row = rows[0];
  return row
    ? {
        stripeCustomerId: row.stripe_customer_id,
        stripePaymentMethodId: row.stripe_payment_method_id,
        status: row.status,
        brand: row.brand,
        last4: row.last4,
        expMonth: row.exp_month,
        expYear: row.exp_year,
      }
    : null;
}

export async function getCampaignPaymentSource(
  sql: postgres.TransactionSql,
): Promise<CampaignPaymentSource | null> {
  const profile = await getStripeBillingProfile(sql);
  if (!profile) return null;
  return {
    status: profile.status,
    brand: profile.brand,
    last4: profile.last4,
    expMonth: profile.expMonth,
    expYear: profile.expYear,
  };
}

export async function ensureStripeBillingProfile(
  sql: postgres.TransactionSql,
  stripeCustomerId: string,
): Promise<void> {
  if (!/^cus_[A-Za-z0-9]+$/u.test(stripeCustomerId))
    throw new TypeError("Invalid Stripe customer identifier");
  await sql`
    INSERT INTO billing.payment_profiles(tenant_id, stripe_customer_id, status)
    VALUES (platform.current_tenant_id(), ${stripeCustomerId}, 'pending')
    ON CONFLICT (tenant_id) DO UPDATE
      SET stripe_customer_id=EXCLUDED.stripe_customer_id,
          updated_at=CURRENT_TIMESTAMP
      WHERE billing.payment_profiles.status='pending'
  `;
}

export async function createCampaignTopup(
  sql: postgres.TransactionSql,
  userId: string,
  amountMinor: number,
  currency: string,
  idempotencyKey: string,
  expectedCustomerId: string,
): Promise<{
  readonly id: string;
  readonly providerSessionId: string | null;
  readonly amountMinor: number;
  readonly currency: string;
}> {
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 100 ||
    amountMinor > 100_000_000
  )
    throw new TypeError("Top-up amount is outside the supported range");
  const normalizedCurrency = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalizedCurrency))
    throw new TypeError("Invalid top-up currency");
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200)
    throw new TypeError("Idempotency key must contain 8 to 200 characters");
  if (!/^cus_[A-Za-z0-9]+$/u.test(expectedCustomerId))
    throw new TypeError("Invalid Stripe customer identifier");
  const rows = await sql<
    {
      id: string;
      provider_session_id: string | null;
      amount_minor: string;
      currency: string;
    }[]
  >`
    INSERT INTO billing.topups
      (tenant_id, requested_by_user_id, amount_minor, currency, provider, idempotency_key, expected_customer_id)
    VALUES (platform.current_tenant_id(), ${userId}::uuid, ${amountMinor}, ${normalizedCurrency}, 'stripe', ${idempotencyKey}, ${expectedCustomerId})
    ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
      WHERE billing.topups.amount_minor=EXCLUDED.amount_minor
        AND billing.topups.currency=EXCLUDED.currency
        AND billing.topups.provider=EXCLUDED.provider
        AND billing.topups.requested_by_user_id=EXCLUDED.requested_by_user_id
        AND billing.topups.expected_customer_id=EXCLUDED.expected_customer_id
    RETURNING id, provider_session_id, amount_minor, currency
  `;
  const row = rows[0];
  // ON CONFLICT locks the existing row before comparing, including concurrent
  // attempts. A reused key never changes its original financial request.
  if (!row)
    throw Object.assign(
      new Error("Idempotency key belongs to a different top-up request"),
      { code: "23505" },
    );
  return {
    id: row.id,
    providerSessionId: row.provider_session_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
  };
}

export async function attachStripeSession(
  sql: postgres.TransactionSql,
  id: string,
  sessionId: string,
): Promise<void> {
  if (!/^cs_[A-Za-z0-9_]+$/u.test(sessionId))
    throw new TypeError("Invalid Stripe checkout identifier");
  const rows = await sql<{ id: string }[]>`
    UPDATE billing.topups SET provider_session_id=${sessionId}
    WHERE id=${id}::uuid AND provider='stripe'
      AND ((provider_session_id IS NULL AND status='pending') OR provider_session_id=${sessionId})
    RETURNING id`;
  if (rows.length !== 1)
    throw Object.assign(new Error("Top-up checkout could not be bound"), {
      code: "23505",
    });
}
