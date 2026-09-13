// Bounded fictional-data benchmark. Never accepts the developer database port.
import postgres from "../packages/ts/crm/node_modules/postgres/src/index.js";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { listContacts } from "../packages/ts/crm/dist/index.js";

const source = new URL(process.env.READINESS_BENCHMARK_URL ?? "");
if (
  source.hostname !== "127.0.0.1" ||
  source.port !== "55439" ||
  source.pathname !== "/oron_readiness"
)
  throw new Error(
    "Only the task-owned disposable readiness cluster is allowed",
  );
const admin = postgres(source.toString(), { max: 1 });
const name = `oron_benchmark_${randomUUID().replaceAll("-", "")}`;
let db;
try {
  await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE oron_readiness`);
  source.pathname = `/${name}`;
  db = postgres(source.toString(), { max: 4 });
  const tenants = [randomUUID(), randomUUID()];
  const user = randomUUID();
  await db`INSERT INTO users(id,email) VALUES (${user}, ${`${user}@example.invalid`})`;
  for (const tenant of tenants) {
    await db`INSERT INTO tenants(id,name,slug) VALUES (${tenant},'Fictional benchmark',${`benchmark-${tenant}`})`;
    await db`INSERT INTO memberships(tenant_id,user_id,role) VALUES (${tenant},${user},'owner')`;
    await db`INSERT INTO crm.contacts(tenant_id,name,created_at)
      SELECT ${tenant}::uuid,'Fictional contact '||n,CURRENT_TIMESTAMP-make_interval(secs=>n)
      FROM generate_series(1,10000) n`;
  }
  await db`ANALYZE crm.contacts`;
  const run = (query = "") =>
    db.begin(async (sql) => {
      await sql`SET LOCAL ROLE platform_web`;
      await sql`SELECT set_config('app.current_tenant',${tenants[0]},true),set_config('app.current_user',${user},true),set_config('app.current_role','owner',true)`;
      const rows = await listContacts(sql, { query, limit: 50 });
      if (rows.length !== 50) throw new Error("Unexpected page size under RLS");
      return rows;
    });
  const cold = performance.now();
  await run();
  const first = performance.now() - cold;
  const measure = async (query) => {
    const values = [];
    for (let batch = 0; batch < 20; batch++) {
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          const start = performance.now();
          await run(query);
          values.push(performance.now() - start);
        }),
      );
    }
    values.sort((a, b) => a - b);
    const percentile = (p) =>
      Number(values[Math.ceil(values.length * p) - 1].toFixed(2));
    return {
      samples: values.length,
      concurrency: 4,
      p50_ms: percentile(0.5),
      p95_ms: percentile(0.95),
      p99_ms: percentile(0.99),
    };
  };
  const listing = await measure("");
  const search = await measure("Fictional");
  const sourceCode = await readFile(
    new URL("../packages/ts/crm/src/contacts.ts", import.meta.url),
    "utf8",
  );
  const projection = sourceCode.match(
    /const contactProjection = `([\s\S]*?)`;/,
  )?.[1];
  if (!projection)
    throw new Error(
      "Query source changed; update the benchmark before comparing",
    );
  const plan = await db.begin(async (sql) => {
    await sql`SET LOCAL ROLE platform_web`;
    await sql`SELECT set_config('app.current_tenant',${tenants[0]},true),set_config('app.current_user',${user},true)`;
    return sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${projection} WHERE c.lifecycle_status <> 'archived' ORDER BY COALESCE(c.last_activity_at,c.created_at) DESC,c.id DESC LIMIT 50`,
    );
  });
  const result = {
    dataset: { tenants: 2, contacts: 20000, channelIdentities: 0, tags: 0 },
    first_observed_ms: Number(first.toFixed(2)),
    listing,
    search,
    conditions:
      "PostgreSQL18.6 Docker desktop; task-owned2CPU/1GiB cluster; platform_web RLS; 4pool; full repository transaction; no HTTP/auth, media or loaded contact identities; concurrent builds/preview may compete for host CPU",
    plan,
  };
  const output = new URL(
    "../.artifacts/readiness-benchmark.json",
    import.meta.url,
  );
  await mkdir(new URL("../.artifacts/", import.meta.url), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, plan: "saved locally" }, null, 2));
} finally {
  if (db) await db.end();
  // Exact generated database in explicitly guarded disposable cluster; no live/user data.
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.end();
}
