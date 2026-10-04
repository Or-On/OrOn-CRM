import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import postgres from "postgres";

const url = process.env.CRM_TEST_DATABASE_URL;
if (!url) throw new Error("Owned synthetic database URL required");
const target = new URL(url);
if (
  target.hostname !== "127.0.0.1" ||
  target.port !== "55480" ||
  !/^\/oron_(?:ui_preview|crm|knowledge)_[a-f0-9]+$/u.test(target.pathname)
)
  throw new Error("Owned synthetic database only");
const sql = postgres(url, { max: 1, prepare: false });
const questions = [
  "shipping",
  "warranty",
  "installation",
  "delivery",
  "maintenance",
  "appointment",
];
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    n: values.length,
    medianMs: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    meanMs: mean,
    stdevMs: Math.sqrt(
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        values.length,
    ),
  };
}
class Rollback extends Error {}
let report: unknown;
try {
  await sql.begin(async (tx) => {
    await tx`set local statement_timeout='10s'`;
    await tx`create temporary table remediation_retrieval_benchmark(
      id integer primary key, tenant integer not null, published boolean not null,
      content text not null, search_vector tsvector generated always as(to_tsvector('simple',content)) stored
    ) on commit drop`;
    await tx`insert into remediation_retrieval_benchmark(id,tenant,published,content)
      select n,case when n<=6000 then 1 else 2 end,n%17<>0,
        (array['shipping','warranty','installation','delivery','maintenance','appointment'])[1+n%6]
        ||' Fictional company policy only. '||repeat('Synthetic bounded business details. ',20)
      from generate_series(1,12000) n`;
    await tx`analyze remediation_retrieval_benchmark`;
    const versions = await tx<{ postgres: string }[]>`select version() postgres`;
    const run = async () => {
      const durations: number[] = [];
      let allTenantCorrect = true;
      const signatures: string[] = [];
      for (let index = 0; index < 66; index++) {
        const question = questions[index % questions.length] ?? "shipping";
        const started = performance.now();
        const rows = await tx<
          { id: number; tenant: number; published: boolean; content: string }[]
        >`
          select id,tenant,published,content from remediation_retrieval_benchmark
          where tenant=1 and published and search_vector @@ plainto_tsquery('simple',${question})
          order by ts_rank_cd(search_vector,plainto_tsquery('simple',${question})) desc,id limit 8`;
        const elapsed = performance.now() - started;
        if (index >= 6) durations.push(elapsed);
        allTenantCorrect &&=
          rows.length === 8 &&
          rows.every(
            (row) =>
              row.tenant === 1 &&
              row.published &&
              row.content.startsWith(question),
          );
        signatures.push(rows.map((row) => row.id).join(","));
      }
      return { stats: stats(durations), allTenantCorrect, signatures };
    };
    const before = await run();
    const beforePlan =
      await tx`explain (analyze,buffers,format json) select id from remediation_retrieval_benchmark where tenant=1 and published and search_vector @@ plainto_tsquery('simple','shipping') order by ts_rank_cd(search_vector,plainto_tsquery('simple','shipping')) desc,id limit 8`;
    await tx`create index on remediation_retrieval_benchmark using gin(search_vector)`;
    await tx`analyze remediation_retrieval_benchmark`;
    const after = await run();
    const afterPlan =
      await tx`explain (analyze,buffers,format json) select id from remediation_retrieval_benchmark where tenant=1 and published and search_vector @@ plainto_tsquery('simple','shipping') order by ts_rank_cd(search_vector,plainto_tsquery('simple','shipping')) desc,id limit 8`;
    const all = await tx<
      { content: string }[]
    >`select content from remediation_retrieval_benchmark where tenant=1 and published order by id`;
    const selected = await tx<
      { content: string }[]
    >`select content from remediation_retrieval_benchmark where tenant=1 and published and search_vector @@ plainto_tsquery('simple','shipping') order by id limit 8`;
    report = {
      measuredAt: new Date().toISOString(),
      node: process.version,
      postgres: versions[0]?.postgres,
      dataset: {
        rows: 12000,
        tenants: 2,
        synthetic: true,
        questionCount: 6,
        repetitions: 60,
        warmup: 6,
      },
      before: before.stats,
      after: after.stats,
      identicalSelectedRows:
        JSON.stringify(before.signatures) === JSON.stringify(after.signatures),
      tenantAndPublicationChecks:
        before.allTenantCorrect && after.allTenantCorrect,
      beforePlan,
      afterPlan,
      promptBytes: {
        allEligibleContent: Buffer.byteLength(JSON.stringify(all)),
        topEightContent: Buffer.byteLength(JSON.stringify(selected)),
      },
      limitations: [
        "Isolated temp-table FTS index microbenchmark, not full production joins or actual retrieveAgentKnowledge latency.",
        "Prompt byte comparison uses different context sets; answer quality and semantic parity are not established.",
        "No provider call or LLM latency/token billing measurement; bytes are not tokens.",
        "Same query/dataset/environment before and after index; cached warm measurements, sequential order may favor after.",
      ],
    };
    throw new Rollback();
  });
} catch (error) {
  if (!(error instanceof Rollback)) throw error;
} finally {
  await sql.end();
}
if (!report) throw new Error("No benchmark report");
await writeFile(
  process.argv[2] ?? "../evidence/retrieval-performance-local.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
