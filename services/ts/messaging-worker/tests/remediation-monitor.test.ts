import postgres, { type Sql } from "postgres";
import { describe, expect, it } from "vitest";
import {
  probeRemediationHealth,
  undeliveredMonitoringIntents,
} from "../src/remediation-monitor.js";

const now = new Date("2026-10-03T20:00:00Z");
function fakeSql() {
  const statements: string[] = [];
  const tx = (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    statements.push(query);
    if (query.includes("from ops.inbound_events"))
      return Promise.resolve([
        { id: "event-a", tenant_id: "tenant-a" },
        { id: "event-a", tenant_id: "tenant-a" },
      ]);
    if (query.includes("from ops.jobs"))
      return Promise.resolve([{ id: "job-b", tenant_id: "tenant-b" }]);
    return Promise.resolve([]);
  };
  return {
    sql: { begin: (fn: (tx: unknown) => unknown) => fn(tx) } as unknown as Sql,
    statements,
  };
}
describe("read-only remediation monitoring", () => {
  it("deduplicates tenant/resource intents without payloads and uses actual job types", async () => {
    const { sql, statements } = fakeSql();
    const result = await probeRemediationHealth(sql, {}, now);
    expect(result.intents.map((x) => x.key)).toEqual([
      "inbound_age:tenant-a:event-a",
      "dead_reply_job:tenant-b:job-b",
    ]);
    expect(result.unavailable).toEqual(["webhook", "worker", "backup"]);
    expect(statements[0]).toContain("read only");
    expect(statements.join(" ")).toContain("whatsapp.outbound.send");
    expect(JSON.stringify(result)).not.toContain("payload");
  });
  it("reports failed and stale health while missing, throwing and future evidence stays unknown", async () => {
    const { sql } = fakeSql();
    const result = await probeRemediationHealth(
      sql,
      {
        webhook: () => Promise.resolve({ healthy: false, observedAt: now }),
        worker: () =>
          Promise.resolve({
            healthy: true,
            observedAt: new Date(now.getTime() - 60_001),
          }),
        backup: () => Promise.reject(new Error("secret must not escape")),
      },
      now,
    );
    expect(
      result.intents
        .filter((x) => x.key.startsWith("health:"))
        .map((x) => x.kind),
    ).toEqual(["webhook", "worker"]);
    expect(result.unavailable).toEqual(["backup"]);
    expect(JSON.stringify(result)).not.toContain("secret");
    const future = await probeRemediationHealth(
      sql,
      {
        webhook: () =>
          Promise.resolve({
            healthy: true,
            observedAt: new Date(now.getTime() + 1),
          }),
      },
      now,
    );
    expect(future.unavailable).toContain("webhook");
  });
  it("only delivered acknowledgments suppress stable keys", async () => {
    const { sql } = fakeSql();
    const { intents } = await probeRemediationHealth(sql, {}, now);
    expect(
      undeliveredMonitoringIntents(
        [...intents, ...intents],
        new Set([intents[0]?.key ?? "missing"]),
      ),
    ).toEqual([intents[1]]);
    expect(undeliveredMonitoringIntents(intents, new Set())).toEqual(intents);
  });
});

const database = process.env.CRM_TEST_DATABASE_URL;
describe.skipIf(!database)("owned PostgreSQL monitoring reads", () => {
  it("executes the actual schema reads without changing job/event counts", async () => {
    if (!database) throw new Error("Owned database URL required");
    const url = new URL(database);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.pathname.startsWith("/oron_")
    )
      throw new Error("Owned synthetic database required");
    const sql = postgres(database, { max: 1 });
    try {
      const before =
        await sql`select (select count(*) from ops.jobs) jobs, (select count(*) from ops.inbound_events) events`;
      const result = await probeRemediationHealth(sql, {}, now);
      const after =
        await sql`select (select count(*) from ops.jobs) jobs, (select count(*) from ops.inbound_events) events`;
      expect(after).toEqual(before);
      expect(result.unavailable).toEqual(["webhook", "worker", "backup"]);
    } finally {
      await sql.end();
    }
  });
});
