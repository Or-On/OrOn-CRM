import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  topup: vi.fn(),
  checkout: vi.fn(),
  attach: vi.fn(),
  insideTransaction: false,
  changedSession: "none",
}));
vi.mock("@or-on/crm", () => ({
  createCampaignTopup: dependencies.topup,
  attachStripeSession: dependencies.attach,
  getCampaignWallet: () => Promise.resolve({ currency: "USD" }),
  getStripeBillingProfile: () =>
    Promise.resolve({
      status: "active",
      stripePaymentMethodId: "pm_fictional",
      stripeCustomerId: "cus_fictional",
    }),
  getCampaignPaymentSource: vi.fn(),
  listCampaignTopups: vi.fn(),
}));
vi.mock("@or-on/config", () => ({
  loadConfig: () => ({
    enableRealBilling: true,
    secrets: { stripeSecretKey: "fictional-no-provider-key" },
    publicSiteUrl: "http://localhost",
  }),
}));
vi.mock("../src/features/finance", () => ({
  createStripeCheckout: dependencies.checkout,
}));
vi.mock("../src/features/auth", () => ({
  assertAuthenticatedMutation: () => Promise.resolve(undefined),
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  jsonObject: (request: Request) => request.json(),
  withCurrentTenant: async (
    _permission: string,
    work: (sql: unknown, session: unknown) => Promise<unknown>,
  ) => {
    dependencies.insideTransaction = true;
    try {
      return await work(
        {},
        {
          userId: "fictional-user",
          sessionId: "fictional-session",
          tenant: { tenantId: "fictional-tenant" },
        },
      );
    } finally {
      dependencies.insideTransaction = false;
    }
  },
  withFreshCurrentTenant: async (
    _permission: string,
    work: (sql: unknown, session: unknown) => Promise<unknown>,
  ) => {
    dependencies.insideTransaction = true;
    try {
      return await work(
        {},
        {
          userId:
            dependencies.changedSession === "user"
              ? "other-user"
              : "fictional-user",
          sessionId:
            dependencies.changedSession === "session"
              ? "other-session"
              : "fictional-session",
          tenant: {
            tenantId:
              dependencies.changedSession === "tenant"
                ? "other-tenant"
                : "fictional-tenant",
          },
        },
      );
    } finally {
      dependencies.insideTransaction = false;
    }
  },
}));

import { POST } from "../src/app/api/billing/topups/route";
const request = () =>
  new Request("http://localhost/api/billing/topups", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "fictional-topup-key",
    },
    body: JSON.stringify({ amount: 12.5 }),
  });

describe("billing top-up request boundary (provider mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.changedSession = "none";
    dependencies.topup.mockResolvedValue({
      id: "fictional-topup",
      providerSessionId: null,
      amountMinor: 1250,
      currency: "USD",
    });
    dependencies.checkout.mockImplementation(() => {
      expect(dependencies.insideTransaction).toBe(false);
      return Promise.resolve({
        id: "cs_fictional",
        url: "https://checkout.example.invalid/fictional",
      });
    });
  });

  it.each(["user", "session", "tenant"])(
    "refuses checkout binding when the fresh %s changed",
    async (kind) => {
      dependencies.changedSession = kind;
      expect((await POST(request())).status).toBe(403);
      expect(dependencies.checkout).toHaveBeenCalledOnce();
      expect(dependencies.attach).not.toHaveBeenCalled();
    },
  );

  it("never opens provider checkout for a changed-payload idempotency conflict", async () => {
    dependencies.topup.mockRejectedValueOnce(
      Object.assign(new Error("private stored row"), { code: "23505" }),
    );
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("private stored row");
    expect(dependencies.checkout).not.toHaveBeenCalled();
    expect(dependencies.attach).not.toHaveBeenCalled();
  });

  it("uses the persisted financial payload outside the admission transaction", async () => {
    dependencies.topup.mockResolvedValueOnce({
      id: "fictional-topup",
      providerSessionId: null,
      amountMinor: 1200,
      currency: "EUR",
    });
    expect((await POST(request())).status).toBe(201);
    expect(dependencies.checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        amountMinor: 1200,
        currency: "EUR",
        topupId: "fictional-topup",
      }),
    );
    expect(dependencies.attach).toHaveBeenCalledOnce();
  });
});
