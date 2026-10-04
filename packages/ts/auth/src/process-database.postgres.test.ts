import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthRepository } from "./repository.js";
import { StaffSmsService } from "./sms.js";
import { withTenantTransaction } from "./tenant-context.js";
import {
  closeProcessDatabasePools,
  PROCESS_DATABASE_MAX_CONNECTIONS,
  withProcessDatabase,
} from "./process-database.js";

const databaseUrl = process.env.AUTH_TEST_DATABASE_URL;
function ownedDatabase(): string {
  if (!databaseUrl) throw new Error("AUTH_TEST_DATABASE_URL is required");
  const url = new URL(databaseUrl);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/oron_ui_preview_[a-f0-9]+$/u.test(url.pathname)
  )
    throw new Error("An owned local fictional database is required");
  return databaseUrl;
}
function runtimeUrl(role: "platform_web" | "platform_messaging") {
  const url = new URL(ownedDatabase());
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

describe.skipIf(!databaseUrl)(
  "shared process database pool (PostgreSQL)",
  () => {
    afterEach(() => closeProcessDatabasePools());

    it("reuses the same connection across module reloads in one process", async () => {
      const url = runtimeUrl("platform_web");
      const first = await withProcessDatabase(
        url,
        async (sql) =>
          (await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]
            ?.pid,
      );
      vi.resetModules();
      const reloaded = await import("./process-database.js");
      const second = await reloaded.withProcessDatabase(
        url,
        async (sql) =>
          (await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]
            ?.pid,
      );
      expect(first).toBeDefined();
      expect(second).toBe(first);
    });

    it("bounds concurrent work to four connections and preserves auth/SMS leases", async () => {
      const url = runtimeUrl("platform_web");
      const repositories = Array.from({ length: 30 }, () =>
        createAuthRepository(url, { sharedPool: true }),
      );
      const sms = new StaffSmsService(url, undefined, undefined, {
        sharedPool: true,
      });
      try {
        const results = await Promise.all(
          Array.from({ length: 30 }, (_, index) =>
            withProcessDatabase(url, async (sql) => {
              const rows = await sql<{ pid: number; role: string }[]>`
            SELECT pg_backend_pid() AS pid, current_user AS role, pg_sleep(0.04)
          `;
              return rows[0];
            }).then(async (result) => {
              expect(
                await repositories[index]?.lookupLogin(
                  "absent-pool-fixture@example.invalid",
                ),
              ).toBeUndefined();
              await repositories[index]?.close();
              return result;
            }),
          ),
        );
        const pids = new Set(results.map((row) => row?.pid));
        expect(pids.size).toBeGreaterThan(1);
        expect(pids.size).toBeLessThanOrEqual(PROCESS_DATABASE_MAX_CONNECTIONS);
        expect(results.every((row) => row?.role === "platform_web")).toBe(true);
        expect(await sms.phoneHint(randomUUID())).toBeUndefined();
        // Closing request wrappers must not close a pool another request uses.
        await sms.close();
        expect(
          await withProcessDatabase(
            url,
            async (sql) => (await sql<{ n: number }[]>`SELECT 1 AS n`)[0]?.n,
          ),
        ).toBe(1);
      } finally {
        await Promise.all(repositories.map((repository) => repository.close()));
        await sms.close();
      }
    });

    it("bounds the verifier to one connection and separates trusted client profiles", async () => {
      const url = runtimeUrl("platform_web");
      const runtimePid = await withProcessDatabase(
        url,
        async (sql) =>
          (await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]
            ?.pid,
      );
      const verifierPids = await Promise.all(
        Array.from({ length: 12 }, () =>
          withProcessDatabase(
            url,
            async (sql) =>
              (
                await sql<
                  { pid: number }[]
                >`SELECT pg_backend_pid() AS pid, pg_sleep(0.01)`
              )[0]?.pid,
            "whatsapp-verifier",
          ),
        ),
      );
      expect(new Set(verifierPids).size).toBe(1);
      expect(verifierPids[0]).not.toBe(runtimePid);
    });

    it("isolates concurrent tenant/user/session RLS context and clears rollback state", async () => {
      const admin = postgres(ownedDatabase(), { max: 1, prepare: false });
      const url = runtimeUrl("platform_web");
      const fixtures = Array.from({ length: 2 }, () => ({
        tenantId: randomUUID(),
        userId: randomUUID(),
        sessionId: randomUUID(),
        contactId: randomUUID(),
      }));
      try {
        for (const fixture of fixtures) {
          await admin`INSERT INTO tenants(id,name,slug,status) VALUES(${fixture.tenantId}::uuid,'Fictional pool tenant',${fixture.tenantId},'active')`;
          await admin`INSERT INTO users(id,email,status) VALUES(${fixture.userId}::uuid,${`${fixture.userId}@example.invalid`},'active')`;
          await admin`INSERT INTO memberships(tenant_id,user_id,role) VALUES(${fixture.tenantId}::uuid,${fixture.userId}::uuid,'owner')`;
          await admin`INSERT INTO crm.contacts(id,tenant_id,name) VALUES(${fixture.contactId}::uuid,${fixture.tenantId}::uuid,'Fictional pool contact')`;
        }
        await Promise.all(
          Array.from({ length: 24 }, async (_, index) => {
            const fixture = fixtures[index % 2];
            if (!fixture) throw new Error("Fixture missing");
            await withTenantTransaction(
              url,
              { ...fixture, role: "owner" },
              async (sql) => {
                const [context] = await sql<
                  { tenant: string; user: string; session: string }[]
                >`
            SELECT current_setting('app.current_tenant') AS tenant,
              current_setting('app.current_user') AS "user", current_setting('app.current_session') AS session,
              pg_sleep(0.01)
          `;
                expect(context).toMatchObject({
                  tenant: fixture.tenantId,
                  user: fixture.userId,
                  session: fixture.sessionId,
                });
                expect(
                  await sql`SELECT id FROM crm.contacts ORDER BY id`,
                ).toEqual([{ id: fixture.contactId }]);
              },
              { sharedPool: true },
            );
          }),
        );
        const fixture = fixtures[0];
        if (!fixture) throw new Error("Fixture missing");
        await expect(
          withTenantTransaction(
            url,
            { ...fixture, role: "owner" },
            async (sql) => {
              await sql`SELECT set_config('app.rollback_fixture','must-not-leak',true)`;
              throw new Error("fictional rollback");
            },
            { sharedPool: true },
          ),
        ).rejects.toThrow("fictional rollback");
        const contexts = await Promise.all(
          Array.from({ length: 12 }, () =>
            withProcessDatabase(
              url,
              (sql) => sql`
        SELECT current_setting('app.current_tenant',true) AS tenant,
          current_setting('app.current_user',true) AS "user", current_setting('app.current_role',true) AS role,
          current_setting('app.current_session',true) AS session, current_setting('app.rollback_fixture',true) AS rollback,
          pg_sleep(0.01)
      `,
            ),
          ),
        );
        for (const rows of contexts)
          for (const key of ["tenant", "user", "role", "session", "rollback"])
            expect(rows[0]?.[key] ?? "").toBe("");
      } finally {
        await closeProcessDatabasePools();
        for (const fixture of fixtures) {
          await admin`DELETE FROM tenants WHERE id=${fixture.tenantId}::uuid`;
          await admin`DELETE FROM users WHERE id=${fixture.userId}::uuid`;
        }
        await admin.end({ timeout: 2 });
      }
    });

    it("does not share credentials or startup role options with a service/migrator connection", async () => {
      const urls = [
        runtimeUrl("platform_web"),
        runtimeUrl("platform_messaging"),
        ownedDatabase(),
      ];
      const results = await Promise.all(
        urls.map((url) =>
          withProcessDatabase(
            url,
            async (sql) =>
              (
                await sql<
                  { pid: number; role: string }[]
                >`SELECT pg_backend_pid() AS pid,current_user AS role`
              )[0],
          ),
        ),
      );
      expect(new Set(results.map((result) => result?.pid)).size).toBe(3);
      expect(results[0]?.role).toBe("platform_web");
      expect(results[1]?.role).toBe("platform_messaging");
      expect(results[2]?.role).not.toBe("platform_web");
      await expect(
        withProcessDatabase(
          urls[0] ?? "",
          (sql) => sql`SELECT * FROM platform.auth_credentials`,
        ),
      ).rejects.toThrow();
      await expect(
        withProcessDatabase(
          urls[1] ?? "",
          (sql) => sql`SELECT * FROM platform.auth_credentials`,
        ),
      ).rejects.toThrow();
    });

    it("drains an active lease before shutdown and removes physical connections", async () => {
      const url = runtimeUrl("platform_web");
      const admin = postgres(ownedDatabase(), { max: 1, prepare: false });
      let allowCompletion!: () => void;
      let notifyStarted!: (pid: number) => void;
      const gate = new Promise<void>((resolve) => {
        allowCompletion = resolve;
      });
      const started = new Promise<number>((resolve) => {
        notifyStarted = resolve;
      });
      const pending = withProcessDatabase(url, async (sql) => {
        const rows = await sql<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        notifyStarted(rows[0]?.pid ?? 0);
        await gate;
        await sql`SELECT 1`;
      });
      try {
        const pid = await started;
        const closing = closeProcessDatabasePools();
        await expect(
          withProcessDatabase(url, (sql) => sql`SELECT 1`),
        ).rejects.toThrow("shutting down");
        expect(
          await admin`SELECT pid FROM pg_stat_activity WHERE pid=${pid}`,
        ).toHaveLength(1);
        allowCompletion();
        await pending;
        await closing;
        expect(
          await admin`SELECT pid FROM pg_stat_activity WHERE pid=${pid}`,
        ).toHaveLength(0);
      } finally {
        allowCompletion();
        await pending;
        await closeProcessDatabasePools();
        await admin.end({ timeout: 2 });
      }
    });
  },
);
