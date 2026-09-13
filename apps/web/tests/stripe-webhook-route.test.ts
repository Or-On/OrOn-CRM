import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sql: vi.fn(),
  end: vi.fn(),
  factory: vi.fn(),
  fetch: vi.fn(),
  config: {
    enableRealBilling: true,
    databaseUrl: "postgresql://fictional.invalid/db",
    secrets: {
      stripeSecretKey: "sk_test_fictional",
      stripeWebhookSecret: "whsec_fictional",
    },
  },
}));
vi.mock("@or-on/config", () => ({ loadConfig: () => state.config }));
vi.mock("postgres", () => ({ default: state.factory }));
import { POST } from "../src/app/api/webhooks/stripe/route";
import { MAX_STRIPE_BODY_BYTES } from "../src/features/finance";

const tenant = "10000000-0000-4000-8000-000000000001";
const requestId = "10000000-0000-4000-8000-000000000002";
function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_fictional",
    mode: "payment",
    customer: "cus_fictional",
    payment_status: "paid",
    amount_total: 1000,
    currency: "usd",
    metadata: { tenant_id: tenant, topup_id: requestId },
    ...overrides,
  };
}
function signed(
  raw: string,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  const digest = createHmac("sha256", "whsec_fictional")
    .update(`${timestamp}.${raw}`)
    .digest("hex");
  return new Request("https://app.example.invalid/api/webhooks/stripe", {
    method: "POST",
    body: raw,
    headers: { "stripe-signature": `t=${timestamp},v1=${digest}` },
  });
}
function event(value = session(), type = "checkout.session.completed") {
  return signed(JSON.stringify({ type, data: { object: value } }));
}
function setup() {
  return session({
    mode: "setup",
    setup_intent: "seti_fictional",
    metadata: {
      tenant_id: tenant,
      purpose: "payment_source",
      setup_request_id: requestId,
    },
  });
}

describe("Stripe checkout webhook boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.config.enableRealBilling = true;
    state.factory.mockReturnValue(Object.assign(state.sql, { end: state.end }));
    state.end.mockResolvedValue(undefined);
    state.sql.mockResolvedValue([{ complete: true }]);
    vi.stubGlobal("fetch", state.fetch);
  });
  it("checks the kill switch without reading data or opening DB", async () => {
    state.config.enableRealBilling = false;
    expect((await POST(event())).status).toBe(503);
    expect(state.factory).not.toHaveBeenCalled();
  });
  it.each(["NaN", "Infinity", "-Infinity", "1.5", "0"])(
    "rejects timestamp %s even with matching HMAC",
    async (stamp) => {
      expect((await POST(signed("{}", stamp))).status).toBe(400);
      expect(state.factory).not.toHaveBeenCalled();
    },
  );
  it.each([
    "{",
    "null",
    "[]",
    '{"type":"checkout.session.completed","data":null}',
  ])("rejects malformed/schema-invalid signed payload %s", async (raw) => {
    expect((await POST(signed(raw))).status).toBe(400);
    expect(state.factory).not.toHaveBeenCalled();
  });
  it("bounds bytes even without a content-length header", async () => {
    expect(
      (await POST(signed("x".repeat(MAX_STRIPE_BODY_BYTES + 1)))).status,
    ).toBe(413);
    expect(state.factory).not.toHaveBeenCalled();
  });
  it.each([
    { customer: null },
    { mode: "subscription" },
    { metadata: { tenant_id: tenant } },
    { amount_total: 1.5 },
    { amount_total: Number.MAX_SAFE_INTEGER + 1 },
    { currency: "invalid" },
  ])("rejects invalid financial fields %j", async (override) => {
    expect((await POST(event(session(override)))).status).toBe(400);
    expect(state.factory).not.toHaveBeenCalled();
  });
  it("passes the exact expected topup/customer/session tuple to the atomic DB primitive", async () => {
    expect((await POST(event())).status).toBe(200);
    expect(state.sql.mock.calls[0]?.slice(1)).toEqual([
      tenant,
      requestId,
      "cs_test_fictional",
      "cus_fictional",
      1000,
      "USD",
    ]);
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.end).toHaveBeenCalledOnce();
  });
  it("requests retry on unmatched or failing storage without leaking errors", async () => {
    state.sql.mockResolvedValueOnce([{ complete: false }]);
    expect((await POST(event())).status).toBe(409);
    state.sql.mockRejectedValueOnce(
      new Error("private account token and SQL detail"),
    );
    const result = await POST(event());
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("private");
  });
  it("does not credit unpaid completion; accepts eventual async paid event", async () => {
    expect(
      (await POST(event(session({ payment_status: "unpaid" })))).status,
    ).toBe(200);
    expect(state.sql).not.toHaveBeenCalled();
    expect(
      (await POST(event(session(), "checkout.session.async_payment_succeeded")))
        .status,
    ).toBe(200);
    expect(state.sql).toHaveBeenCalledOnce();
  });
  it("never retrieves a SetupIntent for an unexpected stored request", async () => {
    state.sql.mockResolvedValueOnce([{ expected: false }]);
    expect((await POST(event(setup()))).status).toBe(409);
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it.each(["requires_payment_method", "processing", "canceled"])(
    "rejects SetupIntent status %s",
    async (status) => {
      state.sql.mockResolvedValueOnce([{ expected: true }]);
      state.fetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "seti_fictional",
            status,
            customer: "cus_fictional",
          }),
        ),
      );
      expect((await POST(event(setup()))).status).toBe(503);
      expect(state.sql).toHaveBeenCalledOnce();
    },
  );
  it.each(["cus_other", "cus_fictional"])(
    "matches setup and payment-method customer %s",
    async (customer) => {
      state.sql
        .mockResolvedValueOnce([{ expected: true }])
        .mockResolvedValueOnce([{ recorded: true }]);
      state.fetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "seti_fictional",
            status: "succeeded",
            customer,
            payment_method: {
              id: "pm_fictional",
              type: "card",
              customer,
              card: {
                brand: "visa",
                last4: "4242",
                exp_month: 12,
                exp_year: 2032,
              },
            },
          }),
        ),
      );
      expect((await POST(event(setup()))).status).toBe(
        customer === "cus_fictional" ? 200 : 503,
      );
      expect(state.sql).toHaveBeenCalledTimes(
        customer === "cus_fictional" ? 2 : 1,
      );
    },
  );
});
