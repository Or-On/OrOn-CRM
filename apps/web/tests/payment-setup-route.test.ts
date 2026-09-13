import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  prepare: vi.fn(),
  attach: vi.fn(),
  checkout: vi.fn(),
  createCustomer: vi.fn(),
  profile: vi.fn(),
  ensure: vi.fn(),
  fresh: vi.fn(),
  enabled: true,
  insideTransaction: false,
  session: {
    userId: "fictional-user",
    sessionId: "fictional-session",
    email: "person@example.invalid",
    tenant: { tenantId: "fictional-tenant" },
  },
}));
vi.mock("@or-on/config", () => ({
  loadConfig: () => ({
    enableRealBilling: state.enabled,
    secrets: { stripeSecretKey: "sk_test_fictional" },
    publicSiteUrl: "https://example.invalid/",
  }),
}));
vi.mock("@or-on/crm", () => ({
  getCampaignWallet: () => Promise.resolve({ currency: "USD" }),
  getStripeBillingProfile: state.profile,
  ensureStripeBillingProfile: state.ensure,
}));
vi.mock("../src/features/finance", () => ({
  preparePaymentSetup: state.prepare,
  attachPaymentSetup: state.attach,
  createStripePaymentSourceCheckout: state.checkout,
  createStripeCustomer: state.createCustomer,
}));
vi.mock("../src/features/auth", () => ({
  assertAuthenticatedMutation: () => Promise.resolve(),
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  withFreshCurrentTenant: state.fresh,
  withCurrentTenant: async (
    _permission: string,
    work: (sql: unknown, session: unknown) => unknown,
  ) => {
    state.insideTransaction = true;
    try {
      return await work({}, state.session);
    } finally {
      state.insideTransaction = false;
    }
  },
}));
import { POST } from "../src/app/api/billing/payment-source/route";

const request = (key = "fictional-request") =>
  new Request("https://example.invalid/api/billing/payment-source", {
    method: "POST",
    headers: { "idempotency-key": key },
  });
describe("durable payment-source admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.enabled = true;
    state.insideTransaction = false;
    state.profile.mockResolvedValue({ stripeCustomerId: "cus_fictional" });
    state.prepare.mockResolvedValue("fictional-setup");
    state.attach.mockResolvedValue(undefined);
    state.fresh.mockImplementation(
      async (
        _permission: string,
        work: (sql: unknown, session: unknown) => unknown,
      ) => {
        state.insideTransaction = true;
        try {
          return await work({}, state.session);
        } finally {
          state.insideTransaction = false;
        }
      },
    );
    state.checkout.mockImplementation(() => {
      expect(state.insideTransaction).toBe(false);
      return Promise.resolve({
        id: "cs_fictional",
        url: "https://checkout.stripe.com/fictional",
      });
    });
  });
  it("persists expectation before checkout and attaches session before releasing URL", async () => {
    expect((await POST(request())).status).toBe(201);
    expect(state.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      state.checkout.mock.invocationCallOrder[0] ?? 0,
    );
    expect(state.checkout.mock.invocationCallOrder[0]).toBeLessThan(
      state.attach.mock.invocationCallOrder[0] ?? 0,
    );
    expect(state.checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        setupRequestId: "fictional-setup",
        customerId: "cus_fictional",
        tenantId: "fictional-tenant",
      }),
    );
    expect(state.attach).toHaveBeenCalledWith(
      {},
      "fictional-setup",
      "cs_fictional",
    );
  });
  it("does not create provider checkout for conflicting replay", async () => {
    state.prepare.mockRejectedValueOnce(
      new TypeError("Payment setup request conflicts with a prior request"),
    );
    expect((await POST(request())).status).toBe(400);
    expect(state.checkout).not.toHaveBeenCalled();
  });
  it("never releases a checkout URL if session attachment failed", async () => {
    state.attach.mockRejectedValueOnce(
      new TypeError("Payment setup session conflicts with a prior request"),
    );
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("checkout.stripe.com");
  });
  it("rejects a changed principal after the external round trip", async () => {
    state.fresh.mockImplementationOnce(
      async (
        _permission: string,
        work: (sql: unknown, session: unknown) => unknown,
      ) =>
        await work(
          {},
          { ...state.session, tenant: { tenantId: "other-tenant" } },
        ),
    );
    expect((await POST(request())).status).toBe(403);
    expect(state.checkout).not.toHaveBeenCalled();
  });
  it.each(["short", "x".repeat(201)])(
    "rejects invalid idempotency keys",
    async (key) => {
      expect((await POST(request(key))).status).toBe(400);
      expect(state.checkout).not.toHaveBeenCalled();
    },
  );
  it("does not start checkout when billing is disabled", async () => {
    state.enabled = false;
    expect((await POST(request())).status).toBe(503);
    expect(state.checkout).not.toHaveBeenCalled();
  });
});
