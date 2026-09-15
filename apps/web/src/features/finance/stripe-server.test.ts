import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStripeCustomer,
  createStripeCheckout,
  createStripePaymentSourceCheckout,
  retrieveStripeCardFromSetupIntent,
  verifyStripeSignature,
} from "./stripe-server";

afterEach(() => vi.unstubAllGlobals());

describe("Stripe webhook verification", () => {
  it("accepts the matching current signature and rejects a mismatch", () => {
    const payload = '{"type":"checkout.session.completed"}';
    const secret = "whsec_fictional_test";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");
    expect(() =>
      verifyStripeSignature(payload, `t=${timestamp},v1=${signature}`, secret),
    ).not.toThrow();
    expect(() =>
      verifyStripeSignature(
        payload,
        `t=${timestamp},v1=${"0".repeat(64)}`,
        secret,
      ),
    ).toThrow("Invalid Stripe webhook signature");
  });
});

describe("Stripe payment sources", () => {
  it("does not expose provider error bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "private recipient and secret",
            },
          }),
          { status: 400 },
        ),
      ),
    );
    await expect(
      createStripeCustomer({
        secretKey: "sk_test_fictional",
        tenantId: "tenant-1",
        email: "fictional@example.invalid",
      }),
    ).rejects.toThrow("Payment provider request failed");
  });
  it("creates a customer without sending card data to Or-On", async () => {
    let captured: RequestInit | undefined;
    const request = vi.fn((_url: string, init?: RequestInit) => {
      captured = init;
      return Promise.resolve(
        new Response(JSON.stringify({ id: "cus_fictional" }), { status: 200 }),
      );
    });
    vi.stubGlobal("fetch", request);
    await expect(
      createStripeCustomer({
        secretKey: "sk_test_fictional",
        tenantId: "tenant-1",
        email: "operator@example.invalid",
      }),
    ).resolves.toBe("cus_fictional");
    const body = captured?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    if (!(body instanceof URLSearchParams))
      throw new Error("Missing form body");
    expect(body.get("email")).toBe("operator@example.invalid");
    expect([...body.keys()].some((key) => key.includes("card"))).toBe(false);
  });

  it("uses Checkout setup mode for the reusable card", async () => {
    let captured: RequestInit | undefined;
    const request = vi.fn((_url: string, init?: RequestInit) => {
      captured = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "cs_setup",
            url: "https://checkout.stripe.test/setup",
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", request);
    await createStripePaymentSourceCheckout({
      secretKey: "sk_test_fictional",
      currency: "USD",
      customerId: "cus_fictional",
      tenantId: "tenant-1",
      siteUrl: "https://app.example.invalid",
      requestKey: "request-123",
      setupRequestId: "request-id",
    });
    const body = captured?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    if (!(body instanceof URLSearchParams))
      throw new Error("Missing form body");
    expect(body.get("mode")).toBe("setup");
    expect(body.get("customer")).toBe("cus_fictional");
    expect(body.get("metadata[purpose]")).toBe("payment_source");
    expect(body.get("success_url")).toBe(
      "https://app.example.invalid/finance?payment_source=success&session_id={CHECKOUT_SESSION_ID}",
    );
    expect(body.get("cancel_url")).toBe(
      "https://app.example.invalid/finance?payment_source=cancelled",
    );
  });

  it("builds valid finance return URLs for top-ups with a trailing slash", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        captured = init;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "cs_topup",
              url: "https://checkout.stripe.test/topup",
            }),
            { status: 200 },
          ),
        );
      }),
    );

    await createStripeCheckout({
      secretKey: "sk_test_fictional",
      amountMinor: 5_000,
      currency: "USD",
      tenantId: "tenant-1",
      topupId: "topup-1",
      siteUrl: "https://app.example.invalid/",
      customerId: "cus_fictional",
    });

    const body = captured?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    if (!(body instanceof URLSearchParams))
      throw new Error("Missing form body");
    expect(body.get("success_url")).toBe(
      "https://app.example.invalid/finance?topup=success",
    );
    expect(body.get("cancel_url")).toBe(
      "https://app.example.invalid/finance?topup=cancelled",
    );
  });

  it("projects only safe card metadata from the completed SetupIntent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "seti_fictional",
            status: "succeeded",
            customer: "cus_fictional",
            payment_method: {
              id: "pm_fictional",
              type: "card",
              customer: "cus_fictional",
              card: {
                brand: "visa",
                last4: "4242",
                exp_month: 12,
                exp_year: 2032,
              },
            },
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(
      retrieveStripeCardFromSetupIntent({
        secretKey: "sk_test_fictional",
        setupIntentId: "seti_fictional",
        expectedCustomerId: "cus_fictional",
      }),
    ).resolves.toEqual({
      paymentMethodId: "pm_fictional",
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2032,
    });
  });
});
