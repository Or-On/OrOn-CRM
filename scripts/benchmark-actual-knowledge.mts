import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import postgres from "postgres";
import {
  createKnowledgeDraft,
  changeKnowledgePublication,
  loadEligibleAgentKnowledge,
} from "../packages/ts/crm/src/knowledge.js";
import { createAgentProfileDraft } from "../packages/ts/crm/src/cross-channel.js";
import { retrieveAgentKnowledge } from "../packages/ts/crm/src/knowledge-retrieval.js";

const url = process.env.FAIR_TEST_DATABASE_URL;
if (!url) throw new Error("Owned independent fixture required");
const target = new URL(url);
if (
  target.hostname !== "127.0.0.1" ||
  target.port !== "55480" ||
  !/^\/oron_fair_[a-f0-9]{32}$/u.test(target.pathname)
)
  throw new Error("Owned independent fixture only");
const db = postgres(url, { max: 1, prepare: false });
const hebrewFact = "מחיר השירות 1234.56 כולל מס.";
class Rollback extends Error {}
let report: unknown;
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    n: values.length,
    medianMs: sorted[Math.floor(values.length / 2)],
    p95Ms: sorted[Math.ceil(values.length * 0.95) - 1],
    meanMs: mean,
    stdevMs: Math.sqrt(
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        values.length,
    ),
  };
};
try {
  await db.begin(async (tx) => {
    await tx`set local statement_timeout='10s'`;
    const fixtures: {
      tenant: string;
      user: string;
      version: string;
      document: string;
    }[] = [];
    for (let index = 0; index < 2; index++) {
      const tenant = randomUUID(),
        user = randomUUID();
      await tx`insert into public.tenants(id,name,slug,status) values(${tenant}::uuid,'Synthetic knowledge benchmark',${`knowledge-bench-${tenant}`},'active')`;
      await tx`insert into public.users(id,email,status) values(${user}::uuid,${`${user}@example.invalid`},'active')`;
      await tx`insert into public.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner')`;
      await tx`select set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${user},true),set_config('app.current_role','owner',true)`;
      await tx`insert into platform.tenant_remediation_flags(tenant_id,flag_key,enabled) values(${tenant}::uuid,'retrieval_fts',true)`;
      const document = await createKnowledgeDraft(tx, user, {
        title: "Synthetic published policies",
        content: "Synthetic company policy benchmark.",
        facts: [
          {
            factKey: "service.price",
            value: "Service price 1234.56 including tax.",
          },
          { factKey: "service.price.he", value: hebrewFact },
        ],
        validFrom: "2020-01-01T00:00:00Z",
        validUntil: null,
      });
      const sources = await tx<
        { source_id: string }[]
      >`select source_id from agents.knowledge_documents where id=${document}::uuid`;
      const source = sources[0]?.source_id;
      if (!source) throw new Error("Source absent");
      const profile = await createAgentProfileDraft(tx, user, {
        name: "Synthetic retrieval agent",
        systemPrompt: "Use published policy.",
        locale: "en",
        channels: ["whatsapp"],
      });
      const versions = await tx<
        { id: string }[]
      >`update agents.agent_profile_versions set published_at=clock_timestamp(),validation_status='valid',knowledge_configuration=${tx.json({ schemaVersion: "1.0", sourceIds: [source] })} where agent_profile_id=${profile}::uuid returning id`;
      const version = versions[0]?.id;
      if (!version) throw new Error("Agent version absent");
      await tx`delete from agents.knowledge_chunks where document_id=${document}::uuid`;
      await tx`insert into agents.knowledge_chunks(tenant_id,document_id,ordinal,content)
    select ${tenant}::uuid,${document}::uuid,n, (array['shipping','warranty','installation','delivery','maintenance','appointment'])[1+n%6]||' term'||(n%200)::text||' Fictional policy. '||repeat('Bounded synthetic business details. ',5) from generate_series(0,5999)n`;
      await changeKnowledgePublication(tx, user, document, "publish");
      fixtures.push({ tenant, user, version, document });
    }
    await tx`analyze agents.knowledge_chunks`;
    const indexes = await tx<
      { indexname: string; indexdef: string }[]
    >`select indexname,indexdef from pg_indexes where schemaname='agents' and tablename='knowledge_chunks' and indexdef ilike '%using gin%' and indexdef like '%search_vector%'`;
    if (indexes.length !== 1)
      throw new Error("Expected exactly one existing search-vector GIN index");
    const index = indexes[0];
    if (!index || !/^[a-z0-9_]+$/u.test(index.indexname))
      throw new Error("Unsafe index identifier");
    const first = fixtures[0],
      other = fixtures[1];
    if (!first || !other) throw new Error("Missing synthetic fixtures");
    await tx`set local role platform_web`;
    await tx`select set_config('app.current_tenant',${first.tenant},true),set_config('app.current_user',${first.user},true),set_config('app.current_role','owner',true)`;
    const input = {
      tenantId: first.tenant,
      agentVersionId: first.version,
      question: "shipping term0",
    };
    const hits = await retrieveAgentKnowledge(tx, input);
    if (
      hits.length !== 8 ||
      hits.some(
        (hit) =>
          hit.tenantId !== first.tenant ||
          hit.facts[0]?.value !== "Service price 1234.56 including tax.",
      )
    )
      throw new Error("Tenant/fact acceptance failed");
    if (
      hits.some(
        (hit) =>
          !hit.facts.some(
            (fact) =>
              fact.factKey === "service.price.he" && fact.value === hebrewFact,
          ),
      )
    )
      throw new Error("Hebrew numeric fact changed");
    if (
      (
        await retrieveAgentKnowledge(tx, {
          ...input,
          tenantId: other.tenant,
          agentVersionId: other.version,
        })
      ).length
    )
      throw new Error("Cross-tenant leakage");
    if (
      (
        await retrieveAgentKnowledge(tx, {
          ...input,
          agentVersionId: other.version,
        })
      ).length
    )
      throw new Error("Cross-agent leakage");
    await tx`reset role`;
    let hasIndex = true;
    const switchIndex = async (enabled: boolean) => {
      if (enabled === hasIndex) return;
      await tx`reset role`;
      if (enabled) await tx.unsafe(index.indexdef);
      else await tx.unsafe(`drop index agents."${index.indexname}"`);
      hasIndex = enabled;
      await tx`set local role platform_web`;
    };
    const timings = { without: [] as number[], with: [] as number[] };
    const signatures = { without: [] as string[], with: [] as string[] };
    for (let iteration = 0; iteration < 124; iteration++) {
      const question =
        [
          "shipping term0",
          "warranty term1",
          "installation term2",
          "delivery term3",
          "maintenance term4",
          "appointment term5",
        ][iteration % 6] ?? "shipping term0";
      for (const enabled of iteration % 2 ? [true, false] : [false, true]) {
        await switchIndex(enabled);
        const started = performance.now();
        const rows = await retrieveAgentKnowledge(tx, { ...input, question });
        const elapsed = performance.now() - started;
        if (iteration >= 4) {
          const phase = enabled ? "with" : "without";
          timings[phase].push(elapsed);
          signatures[phase].push(rows.map((row) => row.chunkId).join(","));
        }
        if (rows.some((row) => row.tenantId !== first.tenant))
          throw new Error("Measured tenant leakage");
      }
    }
    let capturedSql = "",
      capturedValues: unknown[] = [];
    const capturing = ((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      capturedSql = strings.reduce(
        (query, part, index) =>
          query + part + (index < values.length ? `$${String(index + 1)}` : ""),
        "",
      );
      capturedValues = values;
      return Promise.resolve([]);
    }) as unknown as postgres.TransactionSql;
    await retrieveAgentKnowledge(capturing, input);
    await switchIndex(false);
    const beforePlan = await tx.unsafe(
      "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + capturedSql,
      capturedValues as postgres.ParameterOrJSON<never>[],
    );
    await switchIndex(true);
    const afterPlan = await tx.unsafe(
      "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + capturedSql,
      capturedValues as postgres.ParameterOrJSON<never>[],
    );
    const candidate = (
      connection: postgres.TransactionSql,
      question: string,
      ids: readonly string[],
    ) => connection<
      { chunk_id: string; tenant_id: string; metadata: unknown }[]
    >`
    select c.id chunk_id,c.tenant_id,d.metadata
    from agents.knowledge_chunks c
    join agents.knowledge_documents d on d.id=c.document_id and d.tenant_id=c.tenant_id
    join agents.knowledge_sources s on s.id=d.source_id and s.tenant_id=d.tenant_id
    join agents.agent_profile_versions a on a.tenant_id=s.tenant_id
      and (a.knowledge_configuration->'sourceIds') ? s.id::text
    where c.tenant_id=${first.tenant}::uuid and c.tenant_id=platform.current_tenant_id()
      and c.document_id=any(${ids}::uuid[])
      and a.id=${first.version}::uuid and a.published_at is not null and a.validation_status='valid'
      and a.knowledge_configuration->>'schemaVersion'='1.0'
      and jsonb_typeof(a.knowledge_configuration->'sourceIds')='array'
      and s.status='published' and d.published_at is not null and d.revoked_at is null
      and d.valid_from<=clock_timestamp() and (d.valid_until is null or d.valid_until>clock_timestamp())
      and not exists(select 1 from agents.knowledge_documents newer
        where newer.tenant_id=d.tenant_id and newer.source_id=d.source_id
          and newer.published_at is not null and newer.version>d.version)
      and c.search_vector @@ plainto_tsquery('simple',${question})
    order by ts_rank_cd(c.search_vector,plainto_tsquery('simple',${question})) desc,d.id,c.ordinal,c.id limit 8`;
    const twoPhase = async (question: string) => {
      const documents = await loadEligibleAgentKnowledge(tx, first.version);
      return candidate(
        tx,
        question,
        documents.map((document) => document.documentId),
      );
    };
    const pairDurations = {
      original: [] as number[],
      twoPhase: [] as number[],
    };
    let candidateParity = true;
    for (let iteration = 0; iteration < 124; iteration++) {
      const question =
        [
          "shipping term0",
          "warranty term1",
          "installation term2",
          "delivery term3",
          "maintenance term4",
          "appointment term5",
        ][iteration % 6] ?? "shipping term0";
      let originalIds: string[] = [],
        candidateIds: string[] = [];
      for (const variant of iteration % 2
        ? ["twoPhase", "original"]
        : ["original", "twoPhase"]) {
        const started = performance.now();
        if (variant === "original") {
          const rows = await retrieveAgentKnowledge(tx, { ...input, question });
          originalIds = rows.map((row) => row.chunkId);
        } else {
          const rows = await twoPhase(question);
          candidateIds = rows.map((row) => row.chunk_id);
          if (rows.some((row) => row.tenant_id !== first.tenant))
            throw new Error("Candidate tenant leakage");
        }
        const elapsed = performance.now() - started;
        if (iteration >= 4)
          pairDurations[variant === "original" ? "original" : "twoPhase"].push(
            elapsed,
          );
      }
      candidateParity &&=
        JSON.stringify(originalIds) === JSON.stringify(candidateIds);
    }
    let candidateSql = "",
      candidateValues: unknown[] = [];
    const candidateCapture = ((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      candidateSql = strings.reduce(
        (query, part, index) =>
          query + part + (index < values.length ? `$${String(index + 1)}` : ""),
        "",
      );
      candidateValues = values;
      return Promise.resolve([]);
    }) as unknown as postgres.TransactionSql;
    await candidate(candidateCapture, input.question, [first.document]);
    const candidatePlan = await tx.unsafe(
      "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + candidateSql,
      candidateValues as postgres.ParameterOrJSON<never>[],
    );
    const foreignIdsDenied =
      (await candidate(tx, input.question, [other.document])).length === 0;
    const operatorSecurity =
      await tx`select p.proname,p.proleakproof from pg_operator o join pg_proc p on p.oid=o.oprcode where o.oprname='@@' and o.oprleft='tsvector'::regtype and o.oprright='tsquery'::regtype`;
    await tx`reset role`;
    const adminDiagnosticPlan = await tx.unsafe(
      "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + capturedSql,
      capturedValues as postgres.ParameterOrJSON<never>[],
    );
    await tx`set local role platform_web`;
    await changeKnowledgePublication(tx, first.user, first.document, "revoke");
    const revokedIdsDenied =
      (await candidate(tx, input.question, [first.document])).length === 0;
    const postgresVersion = await tx<{ version: string }[]>`select version() version`;
    report = {
      measuredAt: new Date().toISOString(),
      node: process.version,
      postgres: postgresVersion[0]?.version,
      source: "actual retrieveAgentKnowledge tagged SQL and mapping",
      dataset: {
        tenants: 2,
        chunksPerTenant: 6000,
        publishedDocuments: 2,
        questions: 6,
        warmupPairs: 4,
        measuredPairs: 120,
        order: "alternating before/after each pair",
      },
      withoutGIN: stats(timings.without),
      withGIN: stats(timings.with),
      identicalSelectedIds:
        JSON.stringify(signatures.without) === JSON.stringify(signatures.with),
      tenantAndAgentNegativeChecks: true,
      numericFactUnchanged: true,
      beforePlan,
      afterPlan,
      operatorSecurity,
      adminDiagnosticPlan,
      twoPhaseCandidate: {
        original: stats(pairDurations.original),
        candidate: stats(pairDurations.twoPhase),
        identicalSelectedIds: candidateParity,
        foreignIdsDenied,
        revokedIdsDenied,
        candidatePlan,
        adopted: false,
      },
      limitations: [
        "Synthetic selective AND-query workload, not live distribution or full provider latency.",
        "DDL switching excluded from measured query time; alternating pairs reduce ordering bias but shared-host CPU variation remains.",
        "Compared same source query/RLS role/data with and without existing GIN, not changed business behavior or actual release baseline.",
        "Admin plan is diagnostic only; never propose running application as admin or disabling RLS.",
        "Two-phase candidate measured separately and rechecks publication/revocation/config; not adopted in application code.",
      ],
    };
    throw new Rollback();
  });
} catch (error) {
  if (!(error instanceof Rollback)) throw error;
} finally {
  await db.end();
}
if (!report) throw new Error("No actual-query benchmark evidence");
await writeFile(
  process.argv[2] ?? "../evidence/actual-knowledge-performance.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
