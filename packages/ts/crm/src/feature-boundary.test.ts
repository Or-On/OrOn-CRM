import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  attachStripeSession,
  createCampaignTopup,
  ensureStripeBillingProfile,
  getCampaignPaymentSource,
  getCampaignWallet,
  getStripeBillingProfile,
  listCampaignTopups,
} from "./billing.js";
import { listPipelineBoards, moveDeal } from "./pipelines.js";

describe("canonical feature boundaries before domain SQL", () => {
  it.each([
    ["wallet", (sql: postgres.TransactionSql) => getCampaignWallet(sql)],
    [
      "payment source",
      (sql: postgres.TransactionSql) => getCampaignPaymentSource(sql),
    ],
    [
      "billing profile",
      (sql: postgres.TransactionSql) => getStripeBillingProfile(sql),
    ],
    ["topup list", (sql: postgres.TransactionSql) => listCampaignTopups(sql)],
    [
      "profile creation",
      (sql: postgres.TransactionSql) =>
        ensureStripeBillingProfile(sql, "cus_fictional"),
    ],
    [
      "topup creation",
      (sql: postgres.TransactionSql) =>
        createCampaignTopup(
          sql,
          "20000000-0000-4000-8000-000000000001",
          150,
          "USD",
          "fixture-key",
          "cus_fictional",
        ),
    ],
    [
      "checkout binding",
      (sql: postgres.TransactionSql) =>
        attachStripeSession(
          sql,
          "00000000-0000-4000-8000-000000000001",
          "cs_fictional",
        ),
    ],
    [
      "pipeline list",
      (sql: postgres.TransactionSql) => listPipelineBoards(sql),
    ],
    [
      "pipeline move",
      (sql: postgres.TransactionSql) =>
        moveDeal(
          sql,
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
        ),
    ],
  ] as const)(
    "denies disabled %s without reading or changing domain records",
    async (_name, operation) => {
      const query = vi.fn().mockResolvedValue([{ enabled: false }]);
      await expect(
        operation(query as unknown as postgres.TransactionSql),
      ).rejects.toMatchObject({ code: "TENANT_FEATURE_DISABLED" });
      expect(query).toHaveBeenCalledTimes(1);
      expect(
        (query.mock.calls[0]?.[0] as TemplateStringsArray).join("?"),
      ).toContain("current_tenant_feature_enabled");
    },
  );
});
