import type postgres from "postgres";
import {
  defaultAgentQuality,
  parseAgentQuality,
  parseKnowledgeSourceIds,
  qualityId,
  qualityObject,
  qualityText,
  type AgentQualityConfiguration,
} from "./agent-quality.js";
import {
  assertKnowledgeManager,
  auditKnowledge,
  knowledgeConflicts,
  loadEligibleAgentKnowledge,
  parseKnowledgeFacts,
  type EligibleKnowledgeDocument,
} from "./knowledge.js";

export interface AgentQualityVersion {
  readonly id: string;
  readonly version: number;
  readonly systemPrompt: string;
  readonly locale: string;
  readonly publishedAt: string | null;
  readonly validationStatus: string;
  readonly quality: AgentQualityConfiguration;
  readonly sourceIds: readonly string[];
  readonly toolPermissions: readonly string[];
}

export async function listAgentQualityVersions(
  sql: postgres.TransactionSql,
  profileId: string,
): Promise<readonly AgentQualityVersion[]> {
  await assertKnowledgeManager(sql);
  const rows = await sql<
    {
      id: string;
      version: number;
      system_prompt: string;
      locale: string;
      published_at: Date | null;
      validation_status: string;
      channel_configuration: Record<string, unknown>;
      knowledge_configuration: Record<string, unknown>;
      tool_permissions: string[];
    }[]
  >`SELECT id,version,system_prompt,locale,published_at,validation_status,channel_configuration,knowledge_configuration,tool_permissions
    FROM agents.agent_profile_versions WHERE agent_profile_id=${profileId}::uuid ORDER BY version DESC LIMIT 50`;
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    systemPrompt: row.system_prompt,
    locale: row.locale,
    publishedAt: row.published_at?.toISOString() ?? null,
    validationStatus: row.validation_status,
    quality:
      row.channel_configuration.quality === undefined
        ? {
            ...defaultAgentQuality,
            language: row.locale.startsWith("he") ? "he" : "en",
          }
        : parseAgentQuality(row.channel_configuration.quality),
    sourceIds: parseKnowledgeSourceIds(
      row.knowledge_configuration.sourceIds ?? [],
    ),
    toolPermissions: row.tool_permissions.filter(
      (permission) => typeof permission === "string",
    ),
  }));
}

export interface AgentVoiceBinding {
  readonly flowDefinitionId: string;
  readonly flowName: string;
  readonly flowVersion: number;
  readonly voiceFlowId: string | null;
  readonly agentVersionId: string;
  readonly agentVersion: number;
  /** False when the dispatcher would refuse this binding for new calls. */
  readonly callable: boolean;
}

/**
 * Which of this agent's versions new voice calls actually use.
 *
 * Mirrors the dispatcher's resolution (`get_voice_configuration`): the latest
 * published version of each flow definition, and for each `voice.call` node the
 * node's `agentVersionId` or else the flow version's pinned agent version.
 * Saving or publishing a newer agent version does not change this until a flow
 * version bound to it is published; active calls keep their frozen version.
 */
export async function listAgentVoiceBindings(
  sql: postgres.TransactionSql,
  profileId: string,
): Promise<readonly AgentVoiceBinding[]> {
  const rows = await sql<
    {
      flow_definition_id: string;
      flow_name: string;
      flow_version: number;
      voice_flow_id: string | null;
      agent_version_id: string;
      agent_version: number;
      callable: boolean;
    }[]
  >`
    WITH latest AS (
      SELECT DISTINCT ON (flow.flow_definition_id) flow.*
      FROM automation.flow_versions flow
      WHERE flow.published_at IS NOT NULL
      ORDER BY flow.flow_definition_id, flow.version DESC
    )
    SELECT latest.flow_definition_id, definition.name AS flow_name,
           latest.version AS flow_version,
           node #>> '{configuration,flowId}' AS voice_flow_id,
           agent.id AS agent_version_id, agent.version AS agent_version,
           (latest.validation_status = 'valid'
             AND agent.published_at IS NOT NULL
             AND agent.validation_status = 'valid'
             AND 'voice' = ANY(agent.channel_capabilities)) AS callable
    FROM latest
    JOIN automation.flow_definitions definition
      ON definition.id = latest.flow_definition_id
     AND definition.tenant_id = latest.tenant_id
     AND definition.archived_at IS NULL
    CROSS JOIN LATERAL jsonb_array_elements(latest.definition -> 'nodes') node
    JOIN agents.agent_profile_versions agent
      ON agent.tenant_id = latest.tenant_id
     AND (
       (node #>> '{configuration,agentVersionId}' IS NULL
        AND agent.id = latest.agent_profile_version_id)
       OR node #>> '{configuration,agentVersionId}' = agent.id::text
     )
    WHERE node ->> 'type' = 'voice.call'
      AND agent.agent_profile_id = ${profileId}::uuid
    ORDER BY definition.name, latest.flow_definition_id
  `;
  return rows.map((row) => ({
    flowDefinitionId: row.flow_definition_id,
    flowName: row.flow_name,
    flowVersion: row.flow_version,
    voiceFlowId: row.voice_flow_id,
    agentVersionId: row.agent_version_id,
    agentVersion: row.agent_version,
    callable: row.callable,
  }));
}

export async function createAgentQualityDraft(
  sql: postgres.TransactionSql,
  actorId: string,
  profileId: string,
  input: unknown,
): Promise<string> {
  await assertKnowledgeManager(sql);
  const body = qualityObject(input);
  const quality = parseAgentQuality(body.quality);
  const sourceIds = parseKnowledgeSourceIds(body.sourceIds);
  const systemPrompt = qualityText(
    body.systemPrompt,
    "agent instructions",
    16000,
  );
  const baseVersionId = qualityId(body.baseVersionId);
  const latestVersionId = qualityId(body.latestVersionId);
  const profiles =
    await sql`SELECT id FROM agents.agent_profiles WHERE id=${profileId}::uuid AND archived_at IS NULL FOR UPDATE`;
  if (!profiles.length) throw new TypeError("agent profile is unavailable");
  const latest = await sql<
    { id: string }[]
  >`SELECT id FROM agents.agent_profile_versions WHERE agent_profile_id=${profileId}::uuid ORDER BY version DESC LIMIT 1`;
  if (latest[0]?.id !== latestVersionId)
    throw new TypeError("agent version changed; refresh before saving");
  if (sourceIds.length) {
    const sources =
      await sql`SELECT id FROM agents.knowledge_sources WHERE id=ANY(${sourceIds}::uuid[]) AND source_type='approved_manual' FOR SHARE`;
    if (sources.length !== sourceIds.length)
      throw new TypeError("selected knowledge is unavailable in this tenant");
  }
  const rows = await sql<
    { id: string }[]
  >`INSERT INTO agents.agent_profile_versions
      (tenant_id,agent_profile_id,version,schema_version,system_prompt,locale,model_configuration_id,channel_capabilities,
       tool_permissions,knowledge_configuration,channel_configuration,escalation_configuration,validation_status,created_by_user_id)
    SELECT tenant_id,agent_profile_id,(SELECT MAX(version)+1 FROM agents.agent_profile_versions WHERE agent_profile_id=${profileId}::uuid),
      schema_version,${systemPrompt},${quality.language},model_configuration_id,channel_capabilities,tool_permissions,
      ${sql.json({ schemaVersion: "1.0", sourceIds: [...sourceIds] })},
      channel_configuration || ${sql.json({ quality: JSON.parse(JSON.stringify(quality)) as postgres.JSONValue })},
      escalation_configuration,'pending',${actorId}::uuid
    FROM agents.agent_profile_versions WHERE id=${baseVersionId}::uuid AND agent_profile_id=${profileId}::uuid RETURNING id`;
  const id = rows[0]?.id;
  if (!id) throw new TypeError("base version is unavailable in this agent");
  await sql`UPDATE agents.agent_profiles SET updated_at=clock_timestamp() WHERE id=${profileId}::uuid`;
  await auditKnowledge(sql, actorId, "agent_quality.drafted", id);
  return id;
}

export interface AgentQualityEvaluation {
  readonly mode: "deterministic-preview";
  readonly recognizedText: null;
  readonly acceptedText: string;
  readonly response: string;
  readonly decision: "approved-statement" | "clarification";
  readonly sources: readonly EligibleKnowledgeDocument[];
  readonly conflicts: readonly string[];
  readonly toolRequests: readonly never[];
  readonly receipts: readonly never[];
  readonly handoffState: "not-requested";
  readonly audio: "pending-authorized-provider-evaluation";
  readonly timings: {
    readonly deterministicMs: number;
    readonly sttMs: null;
    readonly modelMs: null;
    readonly ttsMs: null;
  };
  readonly providerCost: 0;
}

export async function evaluateAgentQuality(
  sql: postgres.TransactionSql,
  actorId: string,
  profileId: string,
  input: unknown,
): Promise<AgentQualityEvaluation> {
  const started = performance.now();
  await assertKnowledgeManager(sql);
  const body = qualityObject(input);
  const acceptedText = qualityText(body.text, "typed scenario", 2000);
  const versionId = qualityId(body.versionId);
  const versions = await listAgentQualityVersions(sql, profileId);
  const version = versions.find((candidate) => candidate.id === versionId);
  if (!version) throw new TypeError("agent version is unavailable");
  // Draft checks use the latest eligible published sources but never publish the agent.
  const eligible = version.publishedAt
    ? await loadEligibleAgentKnowledge(sql, version.id)
    : await loadDraftKnowledge(sql, version.sourceIds);
  const conflicts = knowledgeConflicts(eligible);
  const factKey = typeof body.factKey === "string" ? body.factKey.trim() : "";
  const matched = conflicts.includes(factKey)
    ? []
    : eligible.flatMap((doc) =>
        doc.facts.filter((fact) => fact.factKey === factKey),
      );
  const response =
    matched[0]?.value ??
    (version.quality.language === "he"
      ? "אין לי כרגע מידע מאושר שעונה על השאלה. איזה פרט כדאי לבדוק?"
      : "I do not have approved information that answers this. Which detail should we check?");
  const unavailable = version.sourceIds.some(
    (sourceId) => !eligible.some((doc) => doc.sourceId === sourceId),
  );
  if (version.publishedAt === null)
    await sql`UPDATE agents.agent_profile_versions
    SET validation_status=${unavailable || conflicts.length ? "invalid" : "valid"},validation_errors=${sql.json({ unavailableKnowledge: unavailable, conflicts: [...conflicts] })}
    WHERE id=${versionId}::uuid AND published_at IS NULL`;
  await auditKnowledge(
    sql,
    actorId,
    "agent_quality.deterministic_tested",
    version.id,
  );
  return {
    mode: "deterministic-preview",
    recognizedText: null,
    acceptedText,
    response,
    decision: matched.length ? "approved-statement" : "clarification",
    sources: eligible,
    conflicts,
    toolRequests: [],
    receipts: [],
    handoffState: "not-requested",
    audio: "pending-authorized-provider-evaluation",
    timings: {
      deterministicMs: Math.round((performance.now() - started) * 100) / 100,
      sttMs: null,
      modelMs: null,
      ttsMs: null,
    },
    providerCost: 0,
  };
}

async function loadDraftKnowledge(
  sql: postgres.TransactionSql,
  sourceIds: readonly string[],
): Promise<readonly EligibleKnowledgeDocument[]> {
  if (!sourceIds.length) return [];
  const rows = await sql<
    {
      tenant_id: string;
      source_id: string;
      id: string;
      version: number;
      title: string;
      metadata: { facts: EligibleKnowledgeDocument["facts"] };
      published_at: Date;
      valid_from: Date;
      valid_until: Date | null;
    }[]
  >`
    SELECT d.* FROM agents.knowledge_sources s JOIN LATERAL
      (SELECT candidate.* FROM agents.knowledge_documents candidate WHERE candidate.source_id=s.id AND candidate.published_at IS NOT NULL ORDER BY candidate.version DESC LIMIT 1) d ON true
    WHERE s.id=ANY(${sourceIds}::uuid[]) AND s.status='published' AND d.revoked_at IS NULL
      AND d.valid_from<=clock_timestamp() AND (d.valid_until IS NULL OR d.valid_until>clock_timestamp()) FOR SHARE OF s`;
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    sourceId: row.source_id,
    documentId: row.id,
    version: row.version,
    title: row.title,
    facts: parseKnowledgeFacts(row.metadata.facts),
    publishedAt: row.published_at.toISOString(),
    validFrom: row.valid_from.toISOString(),
    validUntil: row.valid_until?.toISOString() ?? null,
  }));
}

export async function assertAgentKnowledgePublishable(
  sql: postgres.TransactionSql,
  sourceIds: readonly string[],
): Promise<void> {
  const eligible = await loadDraftKnowledge(sql, sourceIds);
  if (
    eligible.length !== sourceIds.length ||
    knowledgeConflicts(eligible).length
  )
    throw new TypeError(
      "selected knowledge is missing, expired, revoked, or conflicting; test again",
    );
}
