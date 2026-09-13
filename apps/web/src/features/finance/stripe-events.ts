const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_STRIPE_BODY_BYTES = 256 * 1024;

export async function readStripeBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (
    declared &&
    (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_STRIPE_BODY_BYTES)
  )
    throw new RangeError("Webhook body is too large");
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("Invalid webhook body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_STRIPE_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError("Webhook body is too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid checkout event");
  return value as Record<string, unknown>;
}
function identifier(value: unknown, expression: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length > 255 ||
    !expression.test(value)
  )
    throw new TypeError("Invalid checkout event");
  return value;
}

export type StripeCheckoutEvent =
  | { readonly kind: "ignored" }
  | {
      readonly kind: "setup";
      readonly tenantId: string;
      readonly requestId: string;
      readonly sessionId: string;
      readonly customerId: string;
      readonly setupIntentId: string;
    }
  | {
      readonly kind: "payment";
      readonly tenantId: string;
      readonly topupId: string;
      readonly sessionId: string;
      readonly customerId: string;
      readonly amount: number;
      readonly currency: string;
    };

export function parseStripeEvent(raw: Uint8Array): StripeCheckoutEvent {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new TypeError("Invalid checkout event");
  }
  const event = record(decoded);
  if (typeof event.type !== "string")
    throw new TypeError("Invalid checkout event");
  if (
    ![
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ].includes(event.type)
  )
    return { kind: "ignored" };
  const session = record(record(event.data).object);
  const metadata = record(session.metadata);
  const tenantId = identifier(metadata.tenant_id, UUID);
  const sessionId = identifier(session.id, /^cs_[A-Za-z0-9_]+$/);
  const customerId = identifier(session.customer, /^cus_[A-Za-z0-9]+$/);
  if (
    session.mode === "setup" &&
    metadata.purpose === "payment_source" &&
    event.type === "checkout.session.completed"
  ) {
    return {
      kind: "setup",
      tenantId,
      sessionId,
      customerId,
      requestId: identifier(metadata.setup_request_id, UUID),
      setupIntentId: identifier(session.setup_intent, /^seti_[A-Za-z0-9]+$/),
    };
  }
  if (session.mode !== "payment" || metadata.purpose === "payment_source")
    throw new TypeError("Invalid checkout event");
  const topupId = identifier(metadata.topup_id, UUID);
  // Delayed methods can complete Checkout before payment succeeds. No funds yet.
  if (
    session.payment_status === "unpaid" &&
    event.type === "checkout.session.completed"
  )
    return { kind: "ignored" };
  if (
    session.payment_status !== "paid" ||
    typeof session.amount_total !== "number" ||
    !Number.isSafeInteger(session.amount_total) ||
    session.amount_total <= 0
  )
    throw new TypeError("Invalid checkout event");
  return {
    kind: "payment",
    tenantId,
    sessionId,
    customerId,
    topupId,
    amount: session.amount_total,
    currency: identifier(session.currency, /^[a-zA-Z]{3}$/).toUpperCase(),
  };
}
