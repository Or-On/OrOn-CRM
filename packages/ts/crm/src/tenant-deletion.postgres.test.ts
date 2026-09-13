import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  createTenantWithDefaults,
  deleteTenantForAdministrator,
  listPlatformTenants,
} from "./tenants.js";

const databaseUrl = process.env.UI_TEST_DATABASE_URL;
const currentTenantId = "10000000-0000-4000-8000-000000000001";
const superadminId = "20000000-0000-4000-8000-000000000001";

class ExpectedRollback extends Error {}

async function isolated(
  work: (transaction: postgres.TransactionSql) => Promise<void>,
) {
  if (databaseUrl === undefined)
    throw new Error("Use the isolated UI PostgreSQL preview test runner");
  const target = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    !/^\/oron_ui_preview_[a-f0-9]+$/.test(target.pathname)
  )
    throw new Error("Only owned fictional databases are permitted");
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await expect(
      sql.begin(async (transaction) => {
        await transaction`SET LOCAL ROLE platform_web`;
        await transaction`
          SELECT set_config('app.current_tenant', ${currentTenantId}, true),
                 set_config('app.current_user', ${superadminId}, true),
                 set_config('app.current_role', 'owner', true)
        `;
        await work(transaction);
        throw new ExpectedRollback("roll back tenant deletion fixtures");
      }),
    ).rejects.toBeInstanceOf(ExpectedRollback);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

describe.skipIf(databaseUrl === undefined)(
  "guarded platform tenant deletion",
  () => {
    it("removes a different tenant from the active directory", async () => {
      await isolated(async (transaction) => {
        const slug = `delete-fixture-${randomUUID()}`;
        const tenantId = await createTenantWithDefaults(transaction, {
          name: "Fictional tenant deletion",
          slug,
          currency: "USD",
          locale: "en",
          timezone: "UTC",
        });

        await expect(
          deleteTenantForAdministrator(
            transaction,
            tenantId,
            "tenant-deletion-postgres-test",
          ),
        ).resolves.toBe(true);
        expect(
          (await listPlatformTenants(transaction)).some(
            (tenant) => tenant.id === tenantId,
          ),
        ).toBe(false);
        await expect(
          deleteTenantForAdministrator(
            transaction,
            tenantId,
            "tenant-deletion-idempotency-test",
          ),
        ).resolves.toBe(false);
      });
    });

    it("refuses deletion of the session's current tenant", async () => {
      await isolated(async (transaction) => {
        await expect(
          deleteTenantForAdministrator(
            transaction,
            currentTenantId,
            "current-tenant-deletion-test",
          ),
        ).rejects.toMatchObject({ code: "22023" });
      });
    });
  },
);
