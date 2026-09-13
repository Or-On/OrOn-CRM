import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { attachStripeSession, createCampaignTopup } from "./billing.js";

const actor = "20000000-0000-4000-8000-000000000001";
describe("top-up idempotency orchestration (no provider HTTP)", () => {
  it("refuses changing an already bound checkout", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await expect(
      attachStripeSession(
        query as unknown as postgres.TransactionSql,
        "topup",
        "cs_second",
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
  it("returns the stored financial request and compares every immutable request field", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        id: "topup",
        provider_session_id: null,
        amount_minor: "150",
        currency: "USD",
      },
    ]);
    expect(
      await createCampaignTopup(
        query as unknown as postgres.TransactionSql,
        actor,
        150,
        " usd ",
        "topup-key-123",
        "cus_fictional",
      ),
    ).toEqual({
      id: "topup",
      providerSessionId: null,
      amountMinor: 150,
      currency: "USD",
    });
    const statement = (query.mock.calls[0]?.[0] as TemplateStringsArray).join(
      "?",
    );
    for (const field of [
      "amount_minor",
      "currency",
      "provider",
      "requested_by_user_id",
      "expected_customer_id",
    ])
      expect(statement).toContain(`billing.topups.${field}=EXCLUDED.${field}`);
    expect(query.mock.calls[0]).toContain("USD");
  });

  it("rejects a reused key whose immutable payload did not match", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await expect(
      createCampaignTopup(
        query as unknown as postgres.TransactionSql,
        actor,
        200,
        "USD",
        "topup-key-123",
        "cus_fictional",
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it.each([
    [99, "USD", "topup-key-123"],
    [150.5, "USD", "topup-key-123"],
    [150, "US", "topup-key-123"],
    [150, "USD", "short"],
    [150, "USD", "x".repeat(201)],
  ])(
    "rejects invalid request fields before SQL",
    async (amount, currency, key) => {
      const query = vi.fn();
      await expect(
        createCampaignTopup(
          query as unknown as postgres.TransactionSql,
          actor,
          amount,
          currency,
          key,
          "cus_fictional",
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid expected customer identifiers before SQL", async () => {
    const query = vi.fn();
    await expect(
      createCampaignTopup(
        query as unknown as postgres.TransactionSql,
        actor,
        150,
        "USD",
        "topup-key-123",
        "untrusted",
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(query).not.toHaveBeenCalled();
  });
});
