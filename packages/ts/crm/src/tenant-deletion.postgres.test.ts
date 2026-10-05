import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  createTenantWithDefaults,
  deleteTenantForAdministrator,
  listPlatformTenants,
} from "./tenants.js";

const databaseUrl = process.env.UI_TEST_DATABASE_URL;
const currentTenantId = "00000000-0000-0000-0000-000000000001";
const superadminId = "20000000-0000-4000-8000-000000000001";

class ExpectedRollback extends Error {}

async function isolated(
  work: (transaction: postgres.TransactionSql) => Promise<void>,
  ordinaryAdministrator = false,
) {
  if (databaseUrl === undefined)
    throw new Error("Use the isolated UI PostgreSQL preview test runner");
  const target = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    !/^\/oron_ui_preview_[a-f0-9]+$/.test(target.pathname)
  )
    throw new Error("Only owned fictional databases are permitted");
  // UI_TEST_DATABASE_URL deliberately has only runtime grants in CI. Creating
  // the ordinary actor needs the same disposable database's setup connection;
  // the authorization assertions below still execute as platform_web.
  const fixtureUrl = ordinaryAdministrator
    ? process.env.CRM_TEST_DATABASE_URL
    : databaseUrl;
  if (fixtureUrl === undefined)
    throw new Error("Disposable fixture setup connection required");
  const fixtureTarget = new URL(fixtureUrl);
  if (
    fixtureTarget.hostname !== target.hostname ||
    fixtureTarget.port !== target.port ||
    fixtureTarget.pathname !== target.pathname
  )
    throw new Error("Fixture setup must use the same owned preview database");
  const sql = postgres(fixtureUrl, { max: 1, prepare: false });
  try {
    await expect(
      sql.begin(async (transaction) => {
        const actor = ordinaryAdministrator ? randomUUID() : superadminId;
        if (ordinaryAdministrator) {
          await transaction`INSERT INTO public.users(id,email,status) VALUES(${actor}::uuid,${`${actor}@example.invalid`},'active')`;
          await transaction`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${currentTenantId}::uuid,${actor}::uuid,'admin')`;
        }
        await transaction`SET LOCAL ROLE platform_web`;
        await transaction`
          SELECT set_config('app.current_tenant', ${currentTenantId}, true),
                 set_config('app.current_user', ${actor}, true),
                 set_config('app.current_role', ${ordinaryAdministrator ? "admin" : "owner"}, true)
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
    it("hides the directory and rejects cross-tenant mutations outside the main workspace", async () => {
      await isolated(async (transaction) => {
        await transaction`SELECT set_config('app.current_tenant', '10000000-0000-4000-8000-000000000001', true)`;
        expect(await listPlatformTenants(transaction)).toEqual([]);
        for (const operation of [
          (sql: postgres.TransactionSql) =>
            deleteTenantForAdministrator(
              sql,
              currentTenantId,
              "foreign-main-delete",
            ),
          (sql: postgres.TransactionSql) =>
            createTenantWithDefaults(sql, {
              name: "Fictional denied tenant",
              slug: `denied-${randomUUID()}`,
              currency: "USD",
              locale: "en",
              timezone: "UTC",
            }),
          (sql: postgres.TransactionSql) =>
            sql`SELECT platform.set_tenant_feature_entitlement(${currentTenantId}::uuid, false, 'foreign-entitlement')`,
        ]) {
          await expect(
            transaction.savepoint(async (sql) => {
              await operation(sql);
            }),
          ).rejects.toMatchObject({
            code: "42501",
          });
        }
      });
    });

    it("does not grant global authority to an ordinary administrator in the main workspace", async () => {
      await isolated(async (transaction) => {
        expect(await listPlatformTenants(transaction)).toEqual([]);
        await expect(
          deleteTenantForAdministrator(
            transaction,
            "10000000-0000-4000-8000-000000000001",
            "ordinary-admin-delete",
          ),
        ).rejects.toMatchObject({ code: "42501" });
      }, true);
    });
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
