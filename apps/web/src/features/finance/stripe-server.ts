import { createHmac, timingSafeEqual } from "node:crypto";

async function stripePayload(
  response: Response,
): Promise<Record<string, unknown>> {
  // Provider error bodies may contain customer data. Never propagate them.
  if (!response.ok) throw new Error("Payment provider request failed");
  try {
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error();
    return payload as Record<string, unknown>;
  } catch {
    throw new Error("Payment provider returned an invalid response");
  }
}

export async function createStripeCustomer(input: {
  readonly secretKey: string;
  readonly tenantId: string;
  readonly email: string;
}): Promise<string> {
  const response = await fetch("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": `tenant-customer:${input.tenantId}`,
    },
    body: new URLSearchParams({
      email: input.email,
      "metadata[tenant_id]": input.tenantId,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await stripePayload(response);
  if (typeof payload.id !== "string" || !payload.id.startsWith("cus_"))
    throw new Error("Stripe returned an invalid customer identifier");
  return payload.id;
}

export async function createStripePaymentSourceCheckout(input: {
  readonly secretKey: string;
  readonly currency: string;
  readonly customerId: string;
  readonly tenantId: string;
  readonly siteUrl: string;
  readonly requestKey: string;
  readonly setupRequestId: string;
}): Promise<{ readonly id: string; readonly url: string }> {
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": `payment-source:${input.tenantId}:${input.requestKey}`,
    },
    body: new URLSearchParams({
      mode: "setup",
      currency: input.currency.toLowerCase(),
      customer: input.customerId,
      success_url: `${input.siteUrl}finance?payment_source=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${input.siteUrl}finance?payment_source=cancelled`,
      "metadata[purpose]": "payment_source",
      "metadata[tenant_id]": input.tenantId,
      "metadata[setup_request_id]": input.setupRequestId,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await stripePayload(response);
  if (typeof payload.id !== "string" || typeof payload.url !== "string")
    throw new Error("Stripe card setup could not be created");
  return { id: payload.id, url: payload.url };
}

export async function createStripeCheckout(input: {
  readonly secretKey: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly tenantId: string;
  readonly topupId: string;
  readonly siteUrl: string;
  readonly customerId: string;
}): Promise<{ readonly id: string; readonly url: string }> {
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": `campaign-topup:${input.topupId}`,
    },
    body: new URLSearchParams({
      mode: "payment",
      customer: input.customerId,
      success_url: `${input.siteUrl}finance?topup=success`,
      cancel_url: `${input.siteUrl}finance?topup=cancelled`,
      "line_items[0][price_data][currency]": input.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(input.amountMinor),
      "line_items[0][price_data][product_data][name]": "Campaign funds",
      "line_items[0][quantity]": "1",
      "metadata[tenant_id]": input.tenantId,
      "metadata[topup_id]": input.topupId,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await stripePayload(response);
  if (typeof payload.id !== "string" || typeof payload.url !== "string")
    throw new Error("Stripe Checkout could not be created");
  return { id: payload.id, url: payload.url };
}

export interface StripeCardDetails {
  readonly paymentMethodId: string;
  readonly brand: string;
  readonly last4: string;
  readonly expMonth: number;
  readonly expYear: number;
}

export async function retrieveStripeCardFromSetupIntent(input: {
  readonly secretKey: string;
  readonly setupIntentId: string;
  readonly expectedCustomerId: string;
}): Promise<StripeCardDetails> {
  const query = new URLSearchParams({ "expand[]": "payment_method" });
  const response = await fetch(
    `https://api.stripe.com/v1/setup_intents/${encodeURIComponent(input.setupIntentId)}?${query}`,
    {
      headers: { authorization: `Bearer ${input.secretKey}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const payload = await stripePayload(response);
  const paymentMethod = payload.payment_method as
    | {
        id?: unknown;
        type?: unknown;
        customer?: unknown;
        card?: {
          brand?: unknown;
          last4?: unknown;
          exp_month?: unknown;
          exp_year?: unknown;
        };
      }
    | undefined;
  if (
    payload.id !== input.setupIntentId ||
    payload.status !== "succeeded" ||
    payload.customer !== input.expectedCustomerId ||
    paymentMethod?.type !== "card" ||
    paymentMethod.customer !== input.expectedCustomerId ||
    typeof paymentMethod.id !== "string" ||
    !/^pm_[A-Za-z0-9]+$/.test(paymentMethod.id) ||
    typeof paymentMethod.card?.brand !== "string" ||
    !/^[a-zA-Z0-9_ -]{1,32}$/.test(paymentMethod.card.brand) ||
    typeof paymentMethod.card.last4 !== "string" ||
    !/^[0-9]{4}$/.test(paymentMethod.card.last4) ||
    typeof paymentMethod.card.exp_month !== "number" ||
    !Number.isInteger(paymentMethod.card.exp_month) ||
    paymentMethod.card.exp_month < 1 ||
    paymentMethod.card.exp_month > 12 ||
    typeof paymentMethod.card.exp_year !== "number" ||
    !Number.isInteger(paymentMethod.card.exp_year) ||
    paymentMethod.card.exp_year < 2020 ||
    paymentMethod.card.exp_year > 2200
  )
    throw new Error("Stripe setup did not return a reusable card");
  return {
    paymentMethodId: paymentMethod.id,
    brand: paymentMethod.card.brand,
    last4: paymentMethod.card.last4,
    expMonth: paymentMethod.card.exp_month,
    expYear: paymentMethod.card.exp_year,
  };
}

export function verifyStripeSignature(
  payload: string | Uint8Array,
  header: string,
  secret: string,
): void {
  if (header.length > 4096)
    throw new TypeError("Invalid Stripe webhook signature");
  const parts = header.split(",").map((part) => part.trim().split("=", 2));
  const timestamps = parts.filter(([key]) => key === "t");
  const timestamp = timestamps[0]?.[1];
  const signatures = parts
    .filter(([key]) => key === "v1")
    .map(([, value]) => value)
    .filter(Boolean) as string[];
  if (
    timestamps.length !== 1 ||
    !timestamp ||
    !/^[0-9]{1,12}$/.test(timestamp) ||
    !Number.isSafeInteger(Number(timestamp)) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
  )
    throw new TypeError("Invalid Stripe webhook timestamp");
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(payload)
    .digest();
  const expectedBuffer = expected;
  if (
    !signatures.some((signature) => {
      if (!/^[a-fA-F0-9]{64}$/.test(signature)) return false;
      const candidate = Buffer.from(signature, "hex");
      return (
        candidate.length === expectedBuffer.length &&
        timingSafeEqual(candidate, expectedBuffer)
      );
    })
  )
    throw new TypeError("Invalid Stripe webhook signature");
}
