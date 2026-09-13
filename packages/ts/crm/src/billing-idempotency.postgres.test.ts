import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { attachStripeSession, createCampaignTopup } from "./billing.js";

const databaseUrl = process.env.UI_TEST_DATABASE_URL;
const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";

function ownedDatabase() {
  if (!databaseUrl) throw new Error("Use scripts/preview_ui.py --check-db");
  const target = new URL(databaseUrl);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    !/^\/oron_ui_preview_[a-f0-9]+$/.test(target.pathname)
  )
    throw new Error("Only owned fictional databases are permitted");
  return postgres(databaseUrl, { max: 3, prepare: false });
}

async function context(sql: postgres.TransactionSql) {
  await sql`SET LOCAL ROLE platform_web`;
  await sql`SELECT set_config('app.current_tenant', ${tenantId}, true),
    set_config('app.current_user', ${userId}, true), set_config('app.current_role', 'owner', true)`;
}

describe.skipIf(databaseUrl === undefined)(
  "top-up payload idempotency on real PostgreSQL",
  () => {
    it("replays the same request but rejects amount/currency changes without mutating the original", async () => {
      const sql = ownedDatabase();
      const key = `readiness-topup:${randomUUID()}`;
      try {
        await sql.begin(async (tx) => {
          await context(tx);
          const first = await createCampaignTopup(
            tx,
            userId,
            1250,
            "USD",
            key,
            "cus_fictional",
          );
          await attachStripeSession(tx, first.id, "cs_fictional");
          await attachStripeSession(tx, first.id, "cs_fictional");
          await expect(
            attachStripeSession(tx, first.id, "cs_different"),
          ).rejects.toMatchObject({ code: "23505" });
          expect(
            await createCampaignTopup(
              tx,
              userId,
              1250,
              "USD",
              key,
              "cus_fictional",
            ),
          ).toEqual({ ...first, providerSessionId: "cs_fictional" });
          await expect(
            createCampaignTopup(tx, userId, 2500, "USD", key, "cus_fictional"),
          ).rejects.toMatchObject({ code: "23505" });
          await expect(
            createCampaignTopup(tx, userId, 1250, "EUR", key, "cus_fictional"),
          ).rejects.toMatchObject({ code: "23505" });
          await expect(
            createCampaignTopup(tx, userId, 1250, "USD", key, "cus_other"),
          ).rejects.toMatchObject({ code: "23505" });
        });
        await sql.begin(async (tx) => {
          await context(tx);
          const rows = await tx<{ amount_minor: string; currency: string }[]>`
          SELECT amount_minor, currency FROM billing.topups WHERE idempotency_key=${key}`;
          expect(rows).toHaveLength(1);
          expect(Number(rows[0]?.amount_minor)).toBe(1250);
          expect(rows[0]?.currency).toBe("USD");
        });
      } finally {
        await sql.end({ timeout: 2 });
      }
    });

    it("atomically admits only one concurrent mismatched payload for a key", async () => {
      const sql = ownedDatabase();
      const key = `readiness-concurrent-topup:${randomUUID()}`;
      try {
        const results = await Promise.allSettled(
          [1500, 2500].map((amount) =>
            sql.begin(async (tx) => {
              await context(tx);
              return createCampaignTopup(
                tx,
                userId,
                amount,
                "USD",
                key,
                "cus_fictional",
              );
            }),
          ),
        );
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        const failure = results.find((result) => result.status === "rejected");
        expect(failure?.status === "rejected" && failure.reason).toMatchObject({
          code: "23505",
        });
        await sql.begin(async (tx) => {
          await context(tx);
          const rows = await tx<
            { amount_minor: string }[]
          >`SELECT amount_minor FROM billing.topups WHERE idempotency_key=${key}`;
          expect(rows).toHaveLength(1);
          const success = results.find(
            (result) => result.status === "fulfilled",
          );
          expect(Number(rows[0]?.amount_minor)).toBe(
            success?.status === "fulfilled" && success.value.amountMinor,
          );
        });
      } finally {
        await sql.end({ timeout: 2 });
      }
    });
  },
);
