import { NextResponse } from "next/server";
import {
  attachStripeSession,
  createCampaignTopup,
  getCampaignWallet,
  getCampaignPaymentSource,
  getStripeBillingProfile,
  listCampaignTopups,
} from "@or-on/crm";
import { loadConfig } from "@or-on/config";
import {
  ForbiddenError,
  jsonObject,
  withCurrentTenant,
  withFreshCurrentTenant,
} from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";
import { createStripeCheckout } from "../../../../features/finance";

export async function GET() {
  try {
    return NextResponse.json(
      await withCurrentTenant("tenant:manage", async (sql) => ({
        wallet: await getCampaignWallet(sql),
        paymentSource: await getCampaignPaymentSource(sql),
        topups: await listCampaignTopups(sql),
      })),
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const amount = Number(body.amount);
    const amountMinor = Math.round(amount * 100);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!Number.isFinite(amount) || idempotencyKey.length < 8)
      throw new TypeError("Valid amount and idempotency key are required");
    const config = loadConfig(process.env, { service: "web" });
    if (
      !config.enableRealBilling ||
      !config.secrets.stripeSecretKey ||
      !config.publicSiteUrl
    )
      return NextResponse.json(
        { error: "Stripe card payments are not configured" },
        { status: 503 },
      );
    const prepared = await withCurrentTenant(
      "tenant:manage",
      async (sql, session) => {
        const wallet = await getCampaignWallet(sql);
        const profile = await getStripeBillingProfile(sql);
        if (
          profile?.status !== "active" ||
          profile.stripePaymentMethodId === null
        )
          throw new TypeError("Connect a payment card before adding funds");
        const topup = await createCampaignTopup(
          sql,
          session.userId,
          amountMinor,
          wallet.currency,
          idempotencyKey,
          profile.stripeCustomerId,
        );
        return {
          id: topup.id,
          providerSessionId: topup.providerSessionId,
          amountMinor: topup.amountMinor,
          currency: topup.currency,
          customerId: profile.stripeCustomerId,
          tenantId: session.tenant.tenantId,
          userId: session.userId,
          sessionId: session.sessionId,
        };
      },
    );
    if (prepared.providerSessionId !== null)
      throw new TypeError(
        "This top-up already has a Stripe Checkout session; no duplicate was created",
      );
    const checkout = await createStripeCheckout({
      secretKey: config.secrets.stripeSecretKey,
      amountMinor: prepared.amountMinor,
      currency: prepared.currency,
      tenantId: prepared.tenantId,
      topupId: prepared.id,
      siteUrl: config.publicSiteUrl,
      customerId: prepared.customerId,
    });
    await withFreshCurrentTenant("tenant:manage", async (sql, session) => {
      if (
        session.tenant.tenantId !== prepared.tenantId ||
        session.userId !== prepared.userId ||
        session.sessionId !== prepared.sessionId
      )
        throw new ForbiddenError("Forbidden");
      await attachStripeSession(sql, prepared.id, checkout.id);
    });
    return NextResponse.json(
      { id: prepared.id, checkoutUrl: checkout.url },
      { status: 201 },
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
