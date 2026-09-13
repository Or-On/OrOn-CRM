import { NextResponse } from "next/server";

import {
  ensureStripeBillingProfile,
  getCampaignWallet,
  getStripeBillingProfile,
} from "@or-on/crm";
import { loadConfig } from "@or-on/config";

import {
  ForbiddenError,
  withCurrentTenant,
  withFreshCurrentTenant,
} from "../../../../features/auth";
import {
  attachPaymentSetup,
  preparePaymentSetup,
} from "../../../../features/finance";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";
import {
  createStripeCustomer,
  createStripePaymentSourceCheckout,
} from "../../../../features/finance";

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
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
    const requestKey = request.headers.get("idempotency-key") ?? "";
    if (requestKey.length < 8 || requestKey.length > 200)
      throw new TypeError("A valid idempotency key is required");
    const prepared = await withCurrentTenant(
      "tenant:manage",
      async (sql, session) => ({
        currency: (await getCampaignWallet(sql)).currency,
        profile: await getStripeBillingProfile(sql),
        email: session.email,
        tenantId: session.tenant.tenantId,
        userId: session.userId,
        sessionId: session.sessionId,
      }),
    );
    const customerId =
      prepared.profile?.stripeCustomerId ??
      (await createStripeCustomer({
        secretKey: config.secrets.stripeSecretKey,
        tenantId: prepared.tenantId,
        email: prepared.email,
      }));
    const setupRequestId = await withFreshCurrentTenant(
      "tenant:manage",
      async (sql, session) => {
        if (
          session.tenant.tenantId !== prepared.tenantId ||
          session.userId !== prepared.userId ||
          session.sessionId !== prepared.sessionId
        )
          throw new ForbiddenError("Forbidden");
        if (!prepared.profile)
          await ensureStripeBillingProfile(sql, customerId);
        const profile = await getStripeBillingProfile(sql);
        if (profile?.stripeCustomerId !== customerId)
          throw new TypeError("Billing customer changed");
        return preparePaymentSetup(sql, session.userId, customerId, requestKey);
      },
    );
    const checkout = await createStripePaymentSourceCheckout({
      secretKey: config.secrets.stripeSecretKey,
      currency: prepared.currency,
      customerId,
      tenantId: prepared.tenantId,
      siteUrl: config.publicSiteUrl,
      requestKey,
      setupRequestId,
    });
    await withFreshCurrentTenant("tenant:manage", async (sql, session) => {
      if (
        session.tenant.tenantId !== prepared.tenantId ||
        session.userId !== prepared.userId ||
        session.sessionId !== prepared.sessionId
      )
        throw new ForbiddenError("Forbidden");
      await attachPaymentSetup(sql, setupRequestId, checkout.id);
    });
    return NextResponse.json({ checkoutUrl: checkout.url }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
