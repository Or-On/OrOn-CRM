import type { TenantTransaction } from "@or-on/auth";

export async function preparePaymentSetup(
  sql: TenantTransaction,
  userId: string,
  customerId: string,
  requestKey: string,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO billing.payment_setup_requests
      (tenant_id,requested_by_user_id,expected_customer_id,idempotency_key)
    VALUES(platform.current_tenant_id(),${userId}::uuid,${customerId},${requestKey})
    ON CONFLICT (tenant_id,idempotency_key) DO UPDATE
      SET idempotency_key=EXCLUDED.idempotency_key
      WHERE payment_setup_requests.requested_by_user_id=EXCLUDED.requested_by_user_id
        AND payment_setup_requests.expected_customer_id=EXCLUDED.expected_customer_id
        AND payment_setup_requests.status='pending'
    RETURNING id
  `;
  if (!rows[0])
    throw new TypeError("Payment setup request conflicts with a prior request");
  return rows[0].id;
}

export async function attachPaymentSetup(
  sql: TenantTransaction,
  requestId: string,
  sessionId: string,
): Promise<void> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId))
    throw new Error("Invalid checkout identifier");
  const rows = await sql<{ id: string }[]>`
    UPDATE billing.payment_setup_requests SET provider_session_id=${sessionId}
    WHERE id=${requestId}::uuid AND tenant_id=platform.current_tenant_id()
      AND status='pending' AND (provider_session_id IS NULL OR provider_session_id=${sessionId})
    RETURNING id
  `;
  if (!rows[0])
    throw new TypeError("Payment setup session conflicts with a prior request");
}
