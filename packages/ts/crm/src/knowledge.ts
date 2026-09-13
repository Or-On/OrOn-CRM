import { createHash } from "node:crypto";
import type postgres from "postgres";
import {
  parseKnowledgeSourceIds,
  qualityId,
  qualityObject,
  qualityText,
} from "./agent-quality.js";

export interface ApprovedKnowledgeFact {
  readonly factKey: string;
  readonly value: string;
}
export interface EligibleKnowledgeDocument {
  readonly tenantId: string;
  readonly sourceId: string;
  readonly documentId: string;
  readonly version: number;
  readonly publishedAt: string;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly title: string;
  readonly facts: readonly ApprovedKnowledgeFact[];
}
export interface KnowledgeVersion {
  readonly documentId: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly sourceStatus: string;
  readonly version: number;
  readonly title: string;
  readonly content: string;
  readonly facts: readonly ApprovedKnowledgeFact[];
  readonly publishedAt: string | null;
  readonly revokedAt: string | null;
  readonly validFrom: string;
  readonly validUntil: string | null;
}

const unsafeFact =
  /(?:ignore (?:all |previous )?instructions|system\s*prompt|role\s*[:=]|developer\s*message|התעלם מההוראות|הוראות מערכת|(?:refund|payment|booking|message|transfer) (?:was |has been )?(?:confirmed|completed|sent|delivered|processed)|(?:שלחתי|זיכיתי|עדכנתי|קבעתי|אישרתי|העברתי)|(?:התשלום|הזיכוי|ההעברה|ההזמנה) (?:אושר|בוצע|הושלם))/iu;

export function parseKnowledgeFacts(
  value: unknown,
): readonly ApprovedKnowledgeFact[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 40)
    throw new TypeError("provide between 1 and 40 approved statements");
  const facts = value.map((item) => {
    const row = qualityObject(item);
    const factKey = qualityText(row.factKey, "fact key", 80);
    const statement = qualityText(row.value, "approved statement", 1200);
    if (
      !/^[a-z][a-z0-9_.-]{0,79}$/u.test(factKey) ||
      unsafeFact.test(statement)
    )
      throw new TypeError(
        "knowledge must contain business statements, never role instructions or execution receipts",
      );
    return { factKey, value: statement };
  });
  if (new Set(facts.map((fact) => fact.factKey)).size !== facts.length)
    throw new TypeError("fact keys must be unique within a document");
  return facts;
}

export async function assertKnowledgeManager(
  sql: postgres.TransactionSql,
): Promise<void> {
  const rows = await sql<
    { allowed: boolean }[]
  >`SELECT platform.canonical_actor_authorized() AS allowed`;
  if (rows[0]?.allowed !== true)
    throw Object.assign(new Error("active knowledge manager required"), {
      code: "42501",
    });
}

export async function auditKnowledge(
  sql: postgres.TransactionSql,
  actorId: string,
  action: string,
  targetId: string,
): Promise<void> {
  await sql`INSERT INTO audit.records (tenant_id,actor_user_id,action,target_type,target_id)
    VALUES (platform.current_tenant_id(),${actorId}::uuid,${action},'agent_knowledge',${targetId}::uuid)`;
}

export async function listKnowledgeVersions(
  sql: postgres.TransactionSql,
): Promise<readonly KnowledgeVersion[]> {
  await assertKnowledgeManager(sql);
  const rows = await sql<
    {
      document_id: string;
      source_id: string;
      source_name: string;
      source_status: string;
      version: number;
      title: string;
      content: string;
      metadata: unknown;
      published_at: Date | null;
      revoked_at: Date | null;
      valid_from: Date;
      valid_until: Date | null;
    }[]
  >`SELECT d.id AS document_id,s.id AS source_id,s.name AS source_name,s.status AS source_status,
     d.version,d.title,d.metadata,d.published_at,d.revoked_at,d.valid_from,d.valid_until,
     COALESCE((SELECT string_agg(c.content,E'\n' ORDER BY c.ordinal) FROM agents.knowledge_chunks c WHERE c.document_id=d.id),'') AS content
   FROM agents.knowledge_documents d JOIN agents.knowledge_sources s ON s.id=d.source_id AND s.tenant_id=d.tenant_id
   ORDER BY s.created_at DESC,d.version DESC LIMIT 200`;
  return rows.map((row) => ({
    documentId: row.document_id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceStatus: row.source_status,
    version: row.version,
    title: row.title,
    content: row.content,
    facts: storedKnowledgeFacts(row.metadata),
    publishedAt: row.published_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    validFrom: row.valid_from.toISOString(),
    validUntil: row.valid_until?.toISOString() ?? null,
  }));
}

function storedKnowledgeFacts(
  metadata: unknown,
): readonly ApprovedKnowledgeFact[] {
  // Legacy/unrecognized documents are not promoted into approved facts.
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    !("schemaVersion" in metadata) ||
    metadata.schemaVersion !== "1.0"
  )
    return [];
  try {
    return parseKnowledgeFacts(qualityObject(metadata).facts);
  } catch (error) {
    if (error instanceof TypeError) return [];
    throw error;
  }
}

export async function createKnowledgeDraft(
  sql: postgres.TransactionSql,
  actorId: string,
  input: unknown,
): Promise<string> {
  await assertKnowledgeManager(sql);
  const row = qualityObject(input);
  const title = qualityText(row.title, "knowledge title", 160);
  const content = qualityText(row.content, "knowledge content", 16000);
  const facts = parseKnowledgeFacts(row.facts);
  const validFrom = new Date(qualityText(row.validFrom, "valid from", 40));
  const validUntil =
    row.validUntil === null || row.validUntil === ""
      ? null
      : new Date(qualityText(row.validUntil, "valid until", 40));
  if (
    !Number.isFinite(validFrom.getTime()) ||
    (validUntil !== null &&
      (!Number.isFinite(validUntil.getTime()) || validUntil <= validFrom))
  )
    throw new TypeError("knowledge validity interval is invalid");
  let sourceId: string;
  if (row.sourceId === undefined || row.sourceId === "") {
    const source = await sql<
      { id: string }[]
    >`INSERT INTO agents.knowledge_sources(tenant_id,name,source_type,status)
      VALUES(platform.current_tenant_id(),${title},'approved_manual','draft') RETURNING id`;
    const createdSourceId = source[0]?.id;
    if (!createdSourceId) throw new Error("knowledge source insert failed");
    sourceId = createdSourceId;
  } else {
    sourceId = qualityId(row.sourceId);
    const source =
      await sql`SELECT id FROM agents.knowledge_sources WHERE id=${sourceId}::uuid AND source_type='approved_manual' FOR UPDATE`;
    if (source.length !== 1)
      throw new TypeError("knowledge source is unavailable");
  }
  const checksum = createHash("sha256")
    .update(JSON.stringify({ title, content, facts, validFrom, validUntil }))
    .digest("hex");
  const docs = await sql<
    { id: string }[]
  >`INSERT INTO agents.knowledge_documents(tenant_id,source_id,version,title,content_checksum,metadata,valid_from,valid_until)
    SELECT platform.current_tenant_id(),${sourceId}::uuid,COALESCE(MAX(version),0)+1,${title},${checksum},
      ${sql.json({ schemaVersion: "1.0", facts: facts.map((fact) => ({ factKey: fact.factKey, value: fact.value })) })},${validFrom},${validUntil}
    FROM agents.knowledge_documents WHERE source_id=${sourceId}::uuid RETURNING id`;
  const id = docs[0]?.id;
  if (!id) throw new Error("knowledge version insert failed");
  await sql`INSERT INTO agents.knowledge_chunks(tenant_id,document_id,ordinal,content)
    VALUES(platform.current_tenant_id(),${id}::uuid,0,${content})`;
  await auditKnowledge(sql, actorId, "knowledge.drafted", id);
  return id;
}

export async function changeKnowledgePublication(
  sql: postgres.TransactionSql,
  actorId: string,
  documentId: string,
  action: "publish" | "revoke",
): Promise<void> {
  await assertKnowledgeManager(sql);
  parseKnowledgeSourceIds([documentId]);
  const selected = await sql<
    { source_id: string; metadata: unknown }[]
  >`SELECT d.source_id,d.metadata FROM agents.knowledge_documents d
    JOIN agents.knowledge_sources s ON s.id=d.source_id WHERE d.id=${documentId}::uuid FOR UPDATE OF s,d`;
  const doc = selected[0];
  if (!doc) throw new TypeError("knowledge version is unavailable");
  let changed: { id: string }[];
  if (action === "publish") {
    if (!storedKnowledgeFacts(doc.metadata).length)
      throw new TypeError("knowledge has no eligible approved statements");
    changed = await sql<
      { id: string }[]
    >`UPDATE agents.knowledge_documents SET published_at=CURRENT_TIMESTAMP
      WHERE id=${documentId}::uuid AND published_at IS NULL AND revoked_at IS NULL
        AND (valid_until IS NULL OR valid_until>clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM agents.knowledge_documents newer WHERE newer.source_id=${doc.source_id}::uuid AND newer.published_at IS NOT NULL AND newer.version>agents.knowledge_documents.version)
      RETURNING id`;
    if (changed.length)
      await sql`UPDATE agents.knowledge_sources SET status='published' WHERE id=${doc.source_id}::uuid`;
  } else {
    changed = await sql<
      { id: string }[]
    >`UPDATE agents.knowledge_documents SET revoked_at=clock_timestamp()
      WHERE id=${documentId}::uuid AND published_at IS NOT NULL AND revoked_at IS NULL RETURNING id`;
    // Revoke the whole source promptly; a later explicitly published version may re-enable it.
    if (changed.length)
      await sql`UPDATE agents.knowledge_sources SET status='revoked' WHERE id=${doc.source_id}::uuid`;
  }
  if (!changed.length)
    throw new TypeError(
      "knowledge publication state changed; refresh and retry",
    );
  await auditKnowledge(
    sql,
    actorId,
    `knowledge.${action === "publish" ? "published" : "revoked"}`,
    documentId,
  );
}

export async function loadEligibleAgentKnowledge(
  sql: postgres.TransactionSql,
  agentVersionId: string,
): Promise<readonly EligibleKnowledgeDocument[]> {
  const rows = await sql<
    {
      tenant_id: string;
      source_id: string;
      document_id: string;
      version: number;
      title: string;
      metadata: unknown;
      published_at: Date;
      valid_from: Date;
      valid_until: Date | null;
    }[]
  >`SELECT d.tenant_id,d.source_id,d.id AS document_id,d.version,d.title,d.metadata,d.published_at,d.valid_from,d.valid_until
    FROM agents.agent_profile_versions a
    JOIN agents.knowledge_sources s ON s.tenant_id=a.tenant_id AND (a.knowledge_configuration->'sourceIds') ? s.id::text
    JOIN LATERAL (SELECT candidate.* FROM agents.knowledge_documents candidate WHERE candidate.source_id=s.id AND candidate.tenant_id=s.tenant_id AND candidate.published_at IS NOT NULL ORDER BY candidate.version DESC LIMIT 1) d ON true
    WHERE a.id=${agentVersionId}::uuid AND a.published_at IS NOT NULL AND a.validation_status='valid'
      AND a.knowledge_configuration->>'schemaVersion'='1.0'
      AND jsonb_typeof(a.knowledge_configuration->'sourceIds')='array'
      AND s.status='published' AND d.revoked_at IS NULL AND d.valid_from<=clock_timestamp()
      AND (d.valid_until IS NULL OR d.valid_until>clock_timestamp())
    ORDER BY s.id LIMIT 40`;
  return rows
    .map((row) => ({
      tenantId: row.tenant_id,
      sourceId: row.source_id,
      documentId: row.document_id,
      version: row.version,
      title: row.title,
      facts: storedKnowledgeFacts(row.metadata),
      publishedAt: row.published_at.toISOString(),
      validFrom: row.valid_from.toISOString(),
      validUntil: row.valid_until?.toISOString() ?? null,
    }))
    .filter((doc) => doc.facts.length > 0);
}

export function knowledgeConflicts(
  documents: readonly Pick<EligibleKnowledgeDocument, "facts">[],
): readonly string[] {
  const values = new Map<string, Set<string>>();
  for (const document of documents)
    for (const fact of document.facts) {
      const entries = values.get(fact.factKey) ?? new Set<string>();
      entries.add(fact.value);
      values.set(fact.factKey, entries);
    }
  return [...values]
    .filter(([, entries]) => entries.size > 1)
    .map(([key]) => key)
    .sort();
}
