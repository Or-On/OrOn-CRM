import type postgres from "postgres";
import {
  parseKnowledgeFacts,
  type ApprovedKnowledgeFact,
} from "./knowledge.js";

export interface RetrievedKnowledgeChunk {
  readonly tenantId: string;
  readonly documentId: string;
  readonly sourceId: string;
  readonly chunkId: string;
  readonly title: string;
  readonly content: string;
  readonly rank: number;
  readonly facts: readonly ApprovedKnowledgeFact[];
}

/** Only server-resolved tenant/version IDs may be supplied, inside an RLS transaction. */
export async function retrieveAgentKnowledge(
  sql: postgres.TransactionSql,
  input: {
    readonly tenantId: string;
    readonly agentVersionId: string;
    readonly question: string;
  },
): Promise<readonly RetrievedKnowledgeChunk[]> {
  if (!input.question.trim()) return [];
  if (input.question.length > 4096)
    throw new TypeError("knowledge query is too long");
  const rows = await sql<
    {
      tenant_id: string;
      document_id: string;
      source_id: string;
      chunk_id: string;
      title: string;
      content: string;
      rank: number;
      metadata: unknown;
    }[]
  >`
    WITH query AS (SELECT plainto_tsquery('simple'::regconfig, ${input.question}) AS value)
    SELECT d.tenant_id,d.id document_id,s.id source_id,c.id chunk_id,d.title,c.content,
      ts_rank_cd(c.search_vector,query.value) rank,d.metadata
    FROM agents.agent_profile_versions a
    JOIN agents.knowledge_sources s ON s.tenant_id=a.tenant_id
      AND (a.knowledge_configuration->'sourceIds') ? s.id::text
    JOIN LATERAL (SELECT candidate.* FROM agents.knowledge_documents candidate
      WHERE candidate.source_id=s.id AND candidate.tenant_id=s.tenant_id
        AND candidate.published_at IS NOT NULL ORDER BY candidate.version DESC LIMIT 1) d ON true
    JOIN agents.knowledge_chunks c ON c.document_id=d.id AND c.tenant_id=d.tenant_id
    CROSS JOIN query
    WHERE a.id=${input.agentVersionId}::uuid AND a.tenant_id=${input.tenantId}::uuid
      AND a.tenant_id=platform.current_tenant_id()
      AND a.published_at IS NOT NULL AND a.validation_status='valid'
      AND a.knowledge_configuration->>'schemaVersion'='1.0'
      AND jsonb_typeof(a.knowledge_configuration->'sourceIds')='array'
      AND s.status='published' AND d.revoked_at IS NULL
      AND d.valid_from<=clock_timestamp() AND (d.valid_until IS NULL OR d.valid_until>clock_timestamp())
      AND c.search_vector @@ query.value
    ORDER BY rank DESC,d.id,c.ordinal,c.id LIMIT 8
  `;
  return rows.map((row) => {
    let facts: readonly ApprovedKnowledgeFact[] = [];
    if (
      row.metadata &&
      typeof row.metadata === "object" &&
      "schemaVersion" in row.metadata &&
      row.metadata.schemaVersion === "1.0" &&
      "facts" in row.metadata
    ) {
      try {
        facts = parseKnowledgeFacts(row.metadata.facts);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
    return {
      tenantId: row.tenant_id,
      documentId: row.document_id,
      sourceId: row.source_id,
      chunkId: row.chunk_id,
      title: row.title,
      content: row.content,
      rank: row.rank,
      facts,
    };
  });
}
