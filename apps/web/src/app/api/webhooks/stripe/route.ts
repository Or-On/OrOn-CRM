import postgres from "postgres";
import { NextResponse } from "next/server";
import { loadConfig } from "@or-on/config";
import {
  retrieveStripeCardFromSetupIntent,
  verifyStripeSignature,
} from "../../../../features/finance";
import { parseStripeEvent, readStripeBody } from "../../../../features/finance";

export async function POST(request: Request) {
  let config;
  try {
    config = loadConfig(process.env, { requireDatabase: true, service: "web" });
  } catch {
    return NextResponse.json(
      { error: "Billing webhook is unavailable" },
      { status: 503 },
    );
  }
  if (
    !config.enableRealBilling ||
    !config.secrets.stripeSecretKey ||
    !config.secrets.stripeWebhookSecret ||
    !config.databaseUrl
  )
    return NextResponse.json(
      { error: "Billing webhook is disabled" },
      { status: 503 },
    );
  let event;
  try {
    const raw = await readStripeBody(request);
    verifyStripeSignature(
      raw,
      request.headers.get("stripe-signature") ?? "",
      config.secrets.stripeWebhookSecret,
    );
    event = parseStripeEvent(raw);
  } catch (error) {
    return NextResponse.json(
      { error: "Invalid billing webhook" },
      { status: error instanceof RangeError ? 413 : 400 },
    );
  }
  if (event.kind === "ignored") return NextResponse.json({ received: true });
  const sql = postgres(config.databaseUrl, { max: 1, prepare: false });
  try {
    let matched: boolean;
    if (event.kind === "setup") {
      const expected = await sql<{ expected: boolean }[]>`
        SELECT billing.expected_stripe_setup(${event.tenantId}::uuid, ${event.requestId}::uuid,
          ${event.sessionId}, ${event.customerId}) AS expected
      `;
      if (expected[0]?.expected !== true)
        return NextResponse.json(
          { error: "Payment source did not match" },
          { status: 409 },
        );
      // The prior query has committed. No provider requests inside DB transactions.
      const card = await retrieveStripeCardFromSetupIntent({
        secretKey: config.secrets.stripeSecretKey,
        setupIntentId: event.setupIntentId,
        expectedCustomerId: event.customerId,
      });
      const rows = await sql<{ recorded: boolean }[]>`
        SELECT billing.record_stripe_payment_source(
          ${event.tenantId}::uuid, ${event.requestId}::uuid, ${event.sessionId}, ${event.customerId},
          ${event.setupIntentId}, ${card.paymentMethodId}, ${card.brand}, ${card.last4},
          ${card.expMonth}, ${card.expYear}) AS recorded
      `;
      matched = rows[0]?.recorded === true;
    } else {
      const rows = await sql<{ complete: boolean }[]>`
        SELECT billing.complete_stripe_topup(${event.tenantId}::uuid, ${event.topupId}::uuid,
          ${event.sessionId}, ${event.customerId}, ${event.amount}, ${event.currency}) AS complete
      `;
      matched = rows[0]?.complete === true;
    }
    return matched
      ? NextResponse.json({ received: true })
      : NextResponse.json(
          { error: "Billing event did not match" },
          { status: 409 },
        );
  } catch {
    // A non-2xx asks Stripe to retry. Never leak raw Stripe/DB error text or bodies.
    return NextResponse.json(
      { error: "Billing event processing is unavailable" },
      { status: 503 },
    );
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}
