import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createJobWakeup } from "../src/job-wakeup.js";

const source = process.env.CROSS_CHANNEL_TEST_DATABASE_URL;
describe.skipIf(!source)("owned committed job wakeup fixture", () => {
  it("delivers empty committed hints, rolls back silently and reconnects without losing polling", async () => {
    if (source === undefined)
      throw new Error("Explicit synthetic fixture required");
    const target = new URL(source);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
      throw new Error("local synthetic DB only");
    target.pathname = "/postgres";
    const maintenance = postgres(target.toString(), { max: 1 });
    const name = "oron_wakeup_" + randomUUID().replaceAll("-", "");
    await maintenance.unsafe(`CREATE DATABASE "${name}"`);
    target.pathname = "/" + name;
    const db = postgres(target.toString(), { max: 2 });
    const observed = postgres(target.toString(), { max: 1 });
    const wakeups: ReturnType<typeof createJobWakeup>[] = [];
    try {
      execFileSync(
        "uv",
        [
          "run",
          "--no-sync",
          "alembic",
          "-c",
          "db/alembic/alembic.ini",
          "upgrade",
          "head",
        ],
        {
          cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
          env: { ...process.env, DATABASE_URL: target.toString() },
          stdio: "pipe",
        },
      );
      const payloads: string[] = [];
      const subscription = await observed.listen(
        "oron_messaging_jobs",
        (payload) => {
          payloads.push(payload);
        },
      );
      const tenant = randomUUID();
      await db`INSERT INTO public.tenants(id,name,slug) VALUES(${tenant}::uuid,'Fictional wakeup',${tenant})`;
      const insert = async (tx: postgres.TransactionSql) => {
        await tx`INSERT INTO ops.jobs(tenant_id,queue,job_type,payload) VALUES(${tenant}::uuid,'messaging','whatsapp.outbound.send','{}'::jsonb)`;
      };
      await expect(
        db.begin(async (tx) => {
          await insert(tx);
          throw new Error("fictional rollback");
        }),
      ).rejects.toThrow("fictional rollback");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(payloads).toEqual([]);
      await db.begin(insert);
      await expect.poll(() => payloads.length).toBe(1);
      expect(payloads).toEqual([""]);
      const unavailable = new URL(target);
      unavailable.port = "1";
      const fallback = createJobWakeup(unavailable.toString());
      wakeups.push(fallback);
      const fallbackStarted = performance.now();
      await fallback.wait(30);
      expect(performance.now() - fallbackStarted).toBeGreaterThanOrEqual(20);
      await fallback.close();
      const first = createJobWakeup(target.toString()),
        second = createJobWakeup(target.toString());
      wakeups.push(first, second);
      await expect
        .poll(async () =>
          Number(
            (
              await db<
                { count: string }[]
              >`SELECT count(*)::text FROM pg_stat_activity WHERE datname=${name} AND application_name='oron-messaging-wakeup'`
            )[0]?.count ?? "0",
          ),
        )
        .toBe(2);
      await first.wait(10);
      await second.wait(10); // consume initial LISTEN hint
      const awoken = [false, false];
      const pending = [
        first.wait(1000).then(() => {
          awoken[0] = true;
        }),
        second.wait(1000).then(() => {
          awoken[1] = true;
        }),
      ];
      await db.begin(insert);
      await expect.poll(() => awoken, { timeout: 700 }).toEqual([true, true]);
      await Promise.all(pending);
      const claim = (worker: string) =>
        db.begin(async (tx) => {
          await tx`SET LOCAL ROLE platform_messaging`;
          return tx`SELECT id FROM ops.claim_jobs_all_tenants(${worker},'messaging',1,120)`;
        });
      const claims = await Promise.all([
        claim("fictional-worker-a"),
        claim("fictional-worker-b"),
      ]);
      expect(claims.flat()).toHaveLength(2);
      expect(new Set(claims.flat().map((row) => String(row.id))).size).toBe(2);
      await db`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${name} AND application_name='oron-messaging-wakeup'`;
      await first.wait(50); // bounded durable fallback even through disconnect
      await expect
        .poll(
          async () =>
            Number(
              (
                await db<
                  { count: string }[]
                >`SELECT count(*)::text FROM pg_stat_activity WHERE datname=${name} AND application_name='oron-messaging-wakeup'`
              )[0]?.count ?? "0",
            ),
          { timeout: 5000 },
        )
        .toBe(2);
      await first.wait(10);
      await second.wait(10);
      const reconnect = first.wait(1000);
      await db.begin(insert);
      await reconnect;
      const shutdown = first.wait(1000);
      await first.close();
      await shutdown;
      await second.close();
      await expect
        .poll(async () =>
          Number(
            (
              await db<
                { count: string }[]
              >`SELECT count(*)::text FROM pg_stat_activity WHERE datname=${name} AND application_name='oron-messaging-wakeup'`
            )[0]?.count ?? "0",
          ),
        )
        .toBe(0);
      await subscription.unlisten();
    } finally {
      await Promise.all(wakeups.map((wakeup) => wakeup.close()));
      await observed.end({ timeout: 0 });
      await db.end({ timeout: 0 });
      await maintenance.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await maintenance.end();
    }
  }, 120000);
});
