import type postgres from "postgres";

import type { JsonValue } from "./types.js";
import { parseKnowledgeSourceIds } from "./agent-quality.js";
import { assertAgentKnowledgePublishable } from "./agent-quality-store.js";
import { assertKnowledgeManager } from "./knowledge.js";

export const supportedChannels = ["voice", "whatsapp"] as const;
export type SupportedChannel = (typeof supportedChannels)[number];
export type FlowNodeType =
  "start" | "end" | "message.send" | "voice.call" | "crm.update" | "handoff";
const flowNodeTypes: readonly FlowNodeType[] = [
  "start",
  "end",
  "message.send",
  "voice.call",
  "crm.update",
  "handoff",
];

export interface CanonicalFlowNode {
  readonly id: string;
  readonly type: FlowNodeType;
  readonly label?: string;
  readonly configuration?: Readonly<Record<string, JsonValue>>;
}

export interface CanonicalFlowEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface CanonicalFlow {
  readonly schemaVersion: "1.0";
  readonly channels: readonly SupportedChannel[];
  readonly nodes: readonly CanonicalFlowNode[];
  readonly edges: readonly CanonicalFlowEdge[];
}

export function parseCanonicalFlow(value: unknown): CanonicalFlow {
  if (value === null || typeof value !== "object")
    throw new TypeError("flow must be an object");
  const record = value as Readonly<Record<string, unknown>>;
  if (
    record.schemaVersion !== "1.0" ||
    !Array.isArray(record.channels) ||
    !Array.isArray(record.nodes) ||
    !Array.isArray(record.edges)
  )
    throw new TypeError("flow must use canonical schema version 1.0");
  if (record.nodes.length > 100 || record.edges.length > 200)
    throw new TypeError("flow exceeds the supported size");
  const channels = record.channels.map((channel) => {
    if (
      typeof channel !== "string" ||
      !supportedChannels.includes(channel as SupportedChannel)
    )
      throw new TypeError("flow contains an unsupported channel");
    return channel as SupportedChannel;
  });
  const nodes = record.nodes.map((node) => {
    if (node === null || typeof node !== "object")
      throw new TypeError("flow nodes must be objects");
    const candidate = node as Readonly<Record<string, unknown>>;
    if (
      typeof candidate.id !== "string" ||
      !/^[\w-]{1,64}$/u.test(candidate.id) ||
      typeof candidate.type !== "string" ||
      !flowNodeTypes.includes(candidate.type as FlowNodeType)
    )
      throw new TypeError("flow node id/type is invalid");
    const configuration = candidate.configuration;
    const label = candidate.label;
    if (
      label !== undefined &&
      (typeof label !== "string" ||
        label.trim().length === 0 ||
        label.trim().length > 120)
    )
      throw new TypeError("flow node label must contain 1–120 characters");
    if (
      configuration !== undefined &&
      (configuration === null ||
        typeof configuration !== "object" ||
        Array.isArray(configuration))
    )
      throw new TypeError("node configuration must be an object");
    // JSON round-trip detaches the persisted immutable version from caller objects.
    const encoded = JSON.stringify(configuration ?? {});
    if (encoded.length > 64_000)
      throw new TypeError("node configuration is too large");
    JSON.parse(encoded, (key: string, entry: unknown) => {
      if (
        /^(?:access_?token|api_?key|app_?secret|password|private_?key|secret)$/iu.test(
          key,
        )
      )
        throw new TypeError("credentials must never be embedded in flows");
      return entry;
    });
    return {
      id: candidate.id,
      type: candidate.type as FlowNodeType,
      ...(label === undefined ? {} : { label: label.trim() }),
      ...(configuration === undefined
        ? {}
        : { configuration: JSON.parse(encoded) as Record<string, JsonValue> }),
    };
  });
  const edges = record.edges.map((edge) => {
    if (edge === null || typeof edge !== "object")
      throw new TypeError("flow edges must be objects");
    const candidate = edge as Readonly<Record<string, unknown>>;
    if (
      typeof candidate.id !== "string" ||
      !/^[\w-]{1,64}$/u.test(candidate.id) ||
      typeof candidate.source !== "string" ||
      !/^[\w-]{1,64}$/u.test(candidate.source) ||
      typeof candidate.target !== "string" ||
      !/^[\w-]{1,64}$/u.test(candidate.target)
    )
      throw new TypeError("flow edge id/source/target is invalid");
    return {
      id: candidate.id,
      source: candidate.source,
      target: candidate.target,
    };
  });
  return { schemaVersion: "1.0", channels, nodes, edges };
}

export interface FlowValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface CompiledAdapter {
  readonly schemaVersion: "oron-flow.v1" | "wacrm-automation.v1";
  readonly nodes: readonly CanonicalFlowNode[];
  readonly edges: readonly CanonicalFlowEdge[];
}

export type CompiledAdapters = Readonly<
  Partial<Record<SupportedChannel, CompiledAdapter>>
>;

const nodeChannels: Readonly<
  Record<FlowNodeType, readonly SupportedChannel[]>
> = {
  start: supportedChannels,
  end: supportedChannels,
  "message.send": ["whatsapp"],
  "voice.call": ["voice"],
  "crm.update": supportedChannels,
  handoff: supportedChannels,
};

function databaseJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

async function auditAction(
  sql: postgres.TransactionSql,
  actorUserId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Readonly<Record<string, JsonValue>> = {},
): Promise<void> {
  await sql`
    INSERT INTO audit.records
      (tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (platform.current_tenant_id(), ${actorUserId}::uuid, ${action},
            ${targetType}, ${targetId}::uuid, ${sql.json(databaseJson(metadata))})
  `;
}

function sortedUniqueChannels(
  channels: readonly SupportedChannel[],
): readonly SupportedChannel[] {
  return [...new Set(channels)].sort();
}

export function validateCanonicalFlow(flow: CanonicalFlow): FlowValidation {
  const errors: string[] = [];
  const channels = sortedUniqueChannels(flow.channels);
  if (channels.length === 0) errors.push("at least one channel is required");
  if (channels.length !== flow.channels.length)
    errors.push("flow channels must not be duplicated");
  if (channels.some((channel) => !supportedChannels.includes(channel)))
    errors.push("flow contains an unsupported channel");

  const ids = new Set<string>();
  for (const node of flow.nodes) {
    if (node.id.trim() === "") errors.push("node IDs must not be empty");
    if (ids.has(node.id)) errors.push(`duplicate node ID: ${node.id}`);
    ids.add(node.id);
    if (!(node.type in nodeChannels)) {
      errors.push(`node ${node.id} has an unsupported type`);
      continue;
    }
    if (!nodeChannels[node.type].some((channel) => channels.includes(channel)))
      errors.push(`node ${node.id} is unsupported by the selected channels`);
  }
  if (flow.nodes.filter((node) => node.type === "start").length !== 1)
    errors.push("flow must contain exactly one start node");
  if (!flow.nodes.some((node) => node.type === "end"))
    errors.push("flow must contain at least one end node");
  const edgeIds = new Set<string>();
  for (const edge of flow.edges) {
    if (edgeIds.has(edge.id)) errors.push(`duplicate edge ID: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!ids.has(edge.source) || !ids.has(edge.target))
      errors.push(`edge ${edge.id} references a missing node`);
    if (edge.source === edge.target)
      errors.push(`edge ${edge.id} cannot connect a node to itself`);
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)].sort() };
}

function compileAdapter(
  flow: CanonicalFlow,
  channel: SupportedChannel,
): CompiledAdapter {
  const nodes = flow.nodes
    .filter((node) => nodeChannels[node.type].includes(channel))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = flow.edges
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: channel === "voice" ? "oron-flow.v1" : "wacrm-automation.v1",
    nodes,
    edges,
  };
}

export function compileCanonicalFlow(flow: CanonicalFlow): CompiledAdapters {
  const validation = validateCanonicalFlow(flow);
  if (!validation.valid)
    throw new TypeError(
      `invalid canonical flow: ${validation.errors.join("; ")}`,
    );
  return Object.fromEntries(
    sortedUniqueChannels(flow.channels).map((channel) => [
      channel,
      compileAdapter(flow, channel),
    ]),
  );
}

export interface AgentProfileSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly version: number | null;
  readonly versionId: string | null;
  readonly channels: readonly SupportedChannel[];
  readonly published: boolean;
  readonly validationStatus: "pending" | "valid" | "invalid" | null;
  readonly systemPrompt?: string | null;
  readonly locale?: string | null;
  readonly isDefaultWhatsApp?: boolean;
}

interface AgentProfileRow {
  id: string;
  name: string;
  description: string | null;
  version: number | null;
  version_id: string | null;
  channel_capabilities: SupportedChannel[] | null;
  published_at: Date | null;
  validation_status: AgentProfileSummary["validationStatus"];
  system_prompt: string | null;
  locale: string | null;
  is_default_whatsapp: boolean;
}

export async function listAgentProfiles(
  sql: postgres.TransactionSql,
): Promise<readonly AgentProfileSummary[]> {
  const rows = await sql<AgentProfileRow[]>`
    SELECT profile.id, profile.name, profile.description, version.version,
           version.id AS version_id,
           version.channel_capabilities, version.published_at,
           version.validation_status, version.system_prompt, version.locale,
           COALESCE(settings.whatsapp_ai_agent_profile_id = profile.id, false)
             AS is_default_whatsapp
    FROM agents.agent_profiles profile
    LEFT JOIN crm.tenant_settings settings ON settings.tenant_id = profile.tenant_id
    LEFT JOIN LATERAL (
      SELECT candidate.id, candidate.version, candidate.channel_capabilities,
             candidate.published_at, candidate.validation_status,
             candidate.system_prompt, candidate.locale
      FROM agents.agent_profile_versions candidate
      WHERE candidate.agent_profile_id = profile.id
      ORDER BY candidate.version DESC LIMIT 1
    ) version ON true
    WHERE profile.archived_at IS NULL
    ORDER BY profile.updated_at DESC, profile.id DESC
  `;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    versionId: row.version_id,
    channels: row.channel_capabilities ?? [],
    published: row.published_at !== null,
    validationStatus: row.validation_status,
    systemPrompt: row.system_prompt,
    locale: row.locale,
    isDefaultWhatsApp: row.is_default_whatsapp,
  }));
}

export async function renameAgentProfile(
  sql: postgres.TransactionSql,
  actorUserId: string,
  profileId: string,
  name: string,
): Promise<boolean> {
  const normalized = name.trim();
  if (!normalized || normalized.length > 120)
    throw new TypeError("agent name must contain 1–120 characters");
  const rows = await sql<{ id: string }[]>`
    UPDATE agents.agent_profiles
    SET name=${normalized}, updated_at=CURRENT_TIMESTAMP
    WHERE id=${profileId}::uuid AND archived_at IS NULL
    RETURNING id
  `;
  if (rows.length === 1)
    await auditAction(
      sql,
      actorUserId,
      "agent_profile.renamed",
      "agent_profile",
      profileId,
    );
  return rows.length === 1;
}

export async function setDefaultWhatsAppAgent(
  sql: postgres.TransactionSql,
  actorUserId: string,
  profileId: string,
): Promise<boolean> {
  await sql`
    SELECT pg_advisory_xact_lock(hashtextextended(
      platform.current_tenant_id()::text || ':agent-profile:' || ${profileId}, 11
    ))
  `;
  const rows = await sql<{ tenant_id: string }[]>`
    SELECT profile.tenant_id
    FROM agents.agent_profiles profile
    WHERE profile.id=${profileId}::uuid AND profile.archived_at IS NULL
      AND EXISTS (
        SELECT 1 FROM agents.agent_profile_versions version
        WHERE version.agent_profile_id=profile.id
          AND version.published_at IS NOT NULL
          AND version.validation_status='valid'
          AND version.channel_capabilities @> ARRAY['whatsapp']::text[]
    )
    LIMIT 1
  `;
  if (rows[0] === undefined)
    throw new TypeError("a published WhatsApp agent is required");
  const updated = await sql<{ tenant_id: string }[]>`
    UPDATE crm.tenant_settings
    SET whatsapp_ai_agent_profile_id=${profileId}::uuid,
        whatsapp_ai_enabled_by_user_id=${actorUserId}::uuid,
        whatsapp_ai_enabled_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP
    WHERE tenant_id=platform.current_tenant_id()
    RETURNING tenant_id
  `;
  if (updated.length === 1)
    await auditAction(
      sql,
      actorUserId,
      "agent_profile.whatsapp_defaulted",
      "agent_profile",
      profileId,
    );
  return updated.length === 1;
}

export async function archiveAgentProfile(
  sql: postgres.TransactionSql,
  actorUserId: string,
  profileId: string,
): Promise<"archived" | "active" | "not_found"> {
  // The messaging worker has read-only access to agent profiles, so archive and
  // assignment share a transaction-scoped advisory lock instead of requiring a
  // broad UPDATE grant merely to lock a row.
  await sql`
    SELECT pg_advisory_xact_lock(hashtextextended(
      platform.current_tenant_id()::text || ':agent-profile:' || ${profileId}, 11
    ))
  `;
  const profiles = await sql<{ id: string }[]>`
    SELECT id FROM agents.agent_profiles
    WHERE id=${profileId}::uuid AND archived_at IS NULL
  `;
  if (profiles[0] === undefined) return "not_found";
  const active = await sql<{ present: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM messaging.conversations conversation
      JOIN agents.agent_profile_versions version
        ON version.id=conversation.ai_agent_profile_version_id
      WHERE version.agent_profile_id=${profileId}::uuid
        AND conversation.ownership_mode='ai'
        AND conversation.removed_from_inbox_at IS NULL
    ) AS present
  `;
  if (active[0]?.present === true) return "active";
  await sql`
    UPDATE crm.tenant_settings
    SET whatsapp_ai_agent_profile_id=NULL,
        whatsapp_ai_enabled_by_user_id=NULL,
        whatsapp_ai_enabled_at=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE whatsapp_ai_agent_profile_id=${profileId}::uuid
  `;
  const rows = await sql<{ id: string }[]>`
    UPDATE agents.agent_profiles
    SET archived_at=CURRENT_TIMESTAMP,
        name=name || ' · archived ' || left(id::text, 8),
        updated_at=CURRENT_TIMESTAMP
    WHERE id=${profileId}::uuid AND archived_at IS NULL
    RETURNING id
  `;
  if (rows[0] === undefined) return "not_found";
  await auditAction(
    sql,
    actorUserId,
    "agent_profile.archived",
    "agent_profile",
    profileId,
  );
  return "archived";
}

export interface AgentProfileDraftInput {
  readonly name: string;
  readonly description?: string;
  readonly systemPrompt: string;
  readonly locale?: string;
  readonly channels: readonly SupportedChannel[];
  readonly toolPermissions?: readonly string[];
  readonly escalation?: Readonly<Record<string, JsonValue>>;
}

export async function createAgentProfileDraft(
  sql: postgres.TransactionSql,
  actorUserId: string,
  input: AgentProfileDraftInput,
): Promise<string> {
  const name = input.name.trim();
  const prompt = input.systemPrompt.trim();
  const description = input.description?.trim();
  const locale = input.locale?.trim();
  const channels = sortedUniqueChannels(input.channels);
  if (!name) throw new TypeError("agent name is required");
  if (!prompt) throw new TypeError("system prompt is required");
  if (channels.length === 0)
    throw new TypeError("at least one channel is required");
  const profiles = await sql<{ id: string }[]>`
    INSERT INTO agents.agent_profiles
      (tenant_id, name, description, created_by_user_id)
    VALUES (platform.current_tenant_id(), ${name},
            ${description === "" ? null : (description ?? null)}, ${actorUserId}::uuid)
    RETURNING id
  `;
  const profileId = profiles[0]?.id;
  if (profileId === undefined) throw new Error("agent profile insert failed");
  await sql`
    INSERT INTO agents.agent_profile_versions
      (tenant_id, agent_profile_id, version, system_prompt, locale,
       channel_capabilities, tool_permissions, escalation_configuration,
       validation_status, validation_errors, created_by_user_id)
    VALUES (platform.current_tenant_id(), ${profileId}::uuid, 1, ${prompt},
            ${locale === "" ? "en" : (locale ?? "en")}, ${channels},
            ${sql.json(input.toolPermissions ?? [])},
            ${sql.json(input.escalation ?? {})}, 'valid', NULL,
            ${actorUserId}::uuid)
  `;
  await auditAction(
    sql,
    actorUserId,
    "agent_profile.created",
    "agent_profile",
    profileId,
    {
      channels,
    },
  );
  return profileId;
}

export async function publishAgentProfile(
  sql: postgres.TransactionSql,
  actorUserId: string,
  profileId: string,
): Promise<boolean> {
  await assertKnowledgeManager(sql);
  const profiles = await sql<{ id: string }[]>`
    SELECT id FROM agents.agent_profiles
    WHERE id=${profileId}::uuid AND archived_at IS NULL
    FOR UPDATE
  `;
  if (profiles.length === 0) return false;
  // Recheck current source eligibility at publication; a prior draft test may be stale.
  const drafts = await sql<
    {
      id: string;
      published_at: Date | null;
      validation_status: string;
      knowledge_configuration: Record<string, unknown>;
    }[]
  >`
    SELECT id,published_at,validation_status,knowledge_configuration FROM agents.agent_profile_versions
    WHERE agent_profile_id=${profileId}::uuid
    ORDER BY version DESC LIMIT 1 FOR UPDATE
  `;
  const draft = drafts[0];
  if (draft?.published_at !== null || draft.validation_status !== "valid")
    return false;
  await assertAgentKnowledgePublishable(
    sql,
    parseKnowledgeSourceIds(draft.knowledge_configuration.sourceIds ?? []),
  );
  const rows = await sql<{ id: string }[]>`
    UPDATE agents.agent_profile_versions SET published_at = CURRENT_TIMESTAMP
    WHERE id = ${draft.id}::uuid AND published_at IS NULL AND validation_status='valid'
    RETURNING id
  `;
  if (rows.length === 1) {
    await sql`
      UPDATE crm.tenant_settings settings
      SET whatsapp_ai_agent_profile_id=${profileId}::uuid,
          whatsapp_ai_enabled_by_user_id=${actorUserId}::uuid,
          whatsapp_ai_enabled_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP
      WHERE settings.tenant_id=platform.current_tenant_id()
        AND settings.whatsapp_ai_agent_profile_id IS NULL
        AND EXISTS (
          SELECT 1 FROM agents.agent_profile_versions version
          WHERE version.id=${draft.id}::uuid
            AND version.channel_capabilities @> ARRAY['whatsapp']::text[]
        )
    `;
    await auditAction(
      sql,
      actorUserId,
      "agent_profile.published",
      "agent_profile",
      profileId,
    );
  }
  return rows.length === 1;
}

export async function createCanonicalFlowDraft(
  sql: postgres.TransactionSql,
  actorUserId: string,
  name: string,
  agentProfileVersionId: string,
  flow: CanonicalFlow,
): Promise<string> {
  flow = parseCanonicalFlow(flow);
  const validation = validateCanonicalFlow(flow);
  if (!validation.valid)
    throw new TypeError(
      `invalid canonical flow: ${validation.errors.join("; ")}`,
    );
  const definitions = await sql<{ id: string }[]>`
    INSERT INTO automation.flow_definitions
      (tenant_id, name, channel_capabilities, created_by_user_id)
    VALUES (platform.current_tenant_id(), ${name.trim()}, ${flow.channels},
            ${actorUserId}::uuid) RETURNING id
  `;
  const definitionId = definitions[0]?.id;
  if (definitionId === undefined)
    throw new Error("flow definition insert failed");
  await sql`
    INSERT INTO automation.flow_versions
      (tenant_id, flow_definition_id, version, schema_version, definition,
       validation_status, validation_errors, agent_profile_version_id,
       compiled_adapters, created_by_user_id)
    VALUES (platform.current_tenant_id(), ${definitionId}::uuid, 1, '1.0',
            ${sql.json(databaseJson(flow))}, 'valid', NULL,
            ${agentProfileVersionId}::uuid,
            ${sql.json(databaseJson(compileCanonicalFlow(flow)))},
            ${actorUserId}::uuid)
  `;
  await auditAction(
    sql,
    actorUserId,
    "flow.created",
    "flow_definition",
    definitionId,
    {
      channels: flow.channels,
    },
  );
  return definitionId;
}

export async function publishCanonicalFlow(
  sql: postgres.TransactionSql,
  actorUserId: string,
  definitionId: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    WITH candidate AS (
      SELECT flow.id FROM automation.flow_versions flow
      JOIN automation.flow_definitions definition
        ON definition.id=flow.flow_definition_id
       AND definition.tenant_id=flow.tenant_id
       AND definition.archived_at IS NULL
      JOIN agents.agent_profile_versions agent
        ON agent.id = flow.agent_profile_version_id
       AND agent.tenant_id = flow.tenant_id
      WHERE flow.flow_definition_id = ${definitionId}::uuid
        AND flow.published_at IS NULL AND flow.validation_status = 'valid'
        AND agent.published_at IS NOT NULL
        AND agent.validation_status = 'valid'
        AND agent.channel_capabilities @> ARRAY(
          SELECT jsonb_array_elements_text(flow.definition -> 'channels')
        )
      ORDER BY flow.version DESC LIMIT 1
      FOR UPDATE OF flow
    ), published AS (
      UPDATE automation.flow_versions flow
      SET published_at = CURRENT_TIMESTAMP
      FROM candidate
      WHERE flow.id = candidate.id
      RETURNING flow.id, flow.flow_definition_id, flow.definition
    ), updated_definition AS (
      UPDATE automation.flow_definitions definition
      SET channel_capabilities = ARRAY(
            SELECT jsonb_array_elements_text(published.definition -> 'channels')
          ),
          updated_at = CURRENT_TIMESTAMP
      FROM published
      WHERE definition.id = published.flow_definition_id
        AND definition.tenant_id = platform.current_tenant_id()
      RETURNING published.id
    )
    SELECT id FROM updated_definition
  `;
  if (rows.length === 1)
    await auditAction(
      sql,
      actorUserId,
      "flow.published",
      "flow_definition",
      definitionId,
    );
  return rows.length === 1;
}

export interface SimulatedCommand {
  readonly jobId: string;
  readonly queued: boolean;
  readonly mode: "simulator";
}

export interface VoiceOutcomeSummary {
  readonly sessionId: string;
  readonly contactId: string;
  readonly outcome: string;
  readonly createdAt: string;
}

export async function listVoiceOutcomes(
  sql: postgres.TransactionSql,
): Promise<readonly VoiceOutcomeSummary[]> {
  const rows = await sql<
    {
      session_id: string;
      contact_id: string;
      outcome: string;
      created_at: Date;
    }[]
  >`
    SELECT session_id, contact_id, outcome, created_at FROM public.sessions
    WHERE contact_id IS NOT NULL AND outcome IS NOT NULL
      AND status IN ('ended', 'failed')
    ORDER BY created_at DESC, session_id DESC LIMIT 50
  `;
  return rows.map((row) => ({
    sessionId: row.session_id,
    contactId: row.contact_id,
    outcome: row.outcome,
    createdAt: row.created_at.toISOString(),
  }));
}

async function enqueueSimulation(
  sql: postgres.TransactionSql,
  actorUserId: string,
  queue: "messaging" | "voice",
  jobType: string,
  contactId: string,
  idempotencyKey: string,
  payload: Readonly<Record<string, JsonValue>>,
): Promise<SimulatedCommand> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ops.jobs
      (tenant_id, queue, job_type, reference_type, reference_id, payload,
       idempotency_key)
    VALUES (platform.current_tenant_id(), ${queue}, ${jobType}, 'contact',
            ${contactId}::uuid, ${sql.json({ ...payload, mode: "simulator" })},
            ${idempotencyKey})
    ON CONFLICT (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 queue, idempotency_key) WHERE idempotency_key IS NOT NULL
    DO NOTHING
    RETURNING id
  `;
  const inserted = rows[0] !== undefined;
  const existing = inserted
    ? rows
    : await sql<{ id: string }[]>`
        SELECT id FROM ops.jobs
        WHERE tenant_id = platform.current_tenant_id() AND queue = ${queue}
          AND idempotency_key = ${idempotencyKey}
          AND job_type = ${jobType} AND reference_id = ${contactId}::uuid
          AND payload = ${sql.json({ ...payload, mode: "simulator" })}::jsonb
        LIMIT 1
      `;
  const row = existing[0];
  if (row === undefined)
    throw new TypeError("idempotency key belongs to different simulation work");
  if (inserted)
    await auditAction(sql, actorUserId, "simulation.queued", "job", row.id, {
      jobType,
      mode: "simulator",
    });
  return { jobId: row.id, queued: inserted, mode: "simulator" };
}

export async function queueCallOutcomeWhatsAppFollowup(
  sql: postgres.TransactionSql,
  actorUserId: string,
  sessionId: string,
  idempotencyKey: string,
): Promise<SimulatedCommand> {
  const outcomes = await sql<{ contact_id: string; outcome: string }[]>`
    SELECT contact_id, outcome FROM public.sessions
    WHERE session_id = ${sessionId}::uuid AND contact_id IS NOT NULL
      AND outcome IS NOT NULL AND status IN ('ended', 'failed')
  `;
  const outcome = outcomes[0];
  if (outcome === undefined)
    throw new TypeError("a terminal contact-linked call outcome is required");
  const contacts = await sql<{ id: string }[]>`
    SELECT id FROM crm.contacts
    WHERE id = ${outcome.contact_id}::uuid
      AND tenant_id = platform.current_tenant_id()
      AND whatsapp_consent = 'granted' AND whatsapp_opted_out_at IS NULL
    FOR SHARE
  `;
  if (contacts[0] === undefined)
    throw new TypeError("WhatsApp follow-up consent is required");
  return enqueueSimulation(
    sql,
    actorUserId,
    "messaging",
    "cross_channel.whatsapp_followup.simulated",
    outcome.contact_id,
    idempotencyKey,
    {
      contactId: outcome.contact_id,
      outcome: outcome.outcome,
      sessionId,
      template: "call-followup",
    },
  );
}

export async function queueWhatsAppTriggeredCall(
  sql: postgres.TransactionSql,
  actorUserId: string,
  conversationId: string,
  idempotencyKey: string,
  voiceFlow?: { readonly flowId: string; readonly flowVersion: number },
): Promise<SimulatedCommand> {
  const eligible = await sql<{ contact_id: string; eligible: boolean }[]>`
    SELECT conversation.contact_id, (contact.voice_consent = 'granted'
      AND contact.lifecycle_status = 'active') AS eligible
    FROM messaging.conversations conversation
    JOIN crm.contacts contact ON contact.id = conversation.contact_id
    WHERE conversation.id = ${conversationId}::uuid
      AND conversation.removed_from_inbox_at IS NULL
    FOR SHARE OF contact, conversation
  `;
  const candidate = eligible[0];
  if (candidate?.eligible !== true)
    throw new TypeError("voice consent is required before queuing a call");
  return enqueueSimulation(
    sql,
    actorUserId,
    "voice",
    "cross_channel.voice_call.simulated",
    candidate.contact_id,
    idempotencyKey,
    {
      contactId: candidate.contact_id,
      conversationId,
      actorUserId,
      ...voiceFlow,
    },
  );
}

export interface AutomaticCallCommand {
  readonly flowId: string;
  readonly flowVersion: number;
  readonly jobId: string;
  readonly queued: boolean;
}

interface AutomaticCallCandidate {
  contact_identity_id: string;
  contact_id: string;
  destination: string;
  agent_version_id: string;
  canonical_flow_version_id: string;
  ownership_epoch: string;
  trigger_text: string;
  voice_configuration: unknown;
}

/**
 * Admit only a standalone, explicit request for an immediate callback.
 * Compound text is never action-scoped consent; the AI must ask the customer
 * to confirm the callback in a separate message before any real-call side effect.
 */
export function explicitWhatsAppCallbackIntent(text: string): boolean {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const request = normalized.replace(
    /^(?:(?:yes|sure|ok(?:ay)?)(?:\s+please)?|(?:כן|בטח|בסדר)(?:\s+בבקשה)?)[,.:;!?،\s]+/iu,
    "",
  );
  const english =
    /^(?:(?:please\s+)?call\s+me(?:\s+now)?(?:\s+please)?|(?:can|could|would|will)\s+you\s+(?:please\s+)?call\s+me(?:\s+now)?(?:\s+please)?|(?:please\s+)?give\s+me\s+a\s+call(?:\s+now)?(?:\s+please)?|i(?:\s+would|['’]d)\s+like\s+(?:you\s+)?to\s+call\s+me(?:\s+now)?(?:\s+please)?|i\s+want\s+(?:you\s+)?to\s+call\s+me(?:\s+now)?(?:\s+please)?|can\s+i\s+(?:get|have)\s+a\s+call(?:\s+now)?(?:\s+please)?)[.!?\s]*$/iu;
  const hebrew =
    /^(?:(?:בבקשה\s+|אפשר\s+)?(?:תתקשרו|תתקשר|תתקשרי|התקשרו|התקשר|התקשרי|תחזרו|תחזור|תחזרי)\s+אליי?(?:\s+עכשיו)?(?:\s+בבקשה)?|אפשר\s+ש(?:תתקשרו|תתקשר|תתקשרי|תחזרו|תחזור|תחזרי)\s+אליי?(?:\s+עכשיו)?(?:\s+בבקשה)?|(?:אשמח|אני\s+(?:אשמח|רוצה))\s+ש(?:תתקשרו|תתקשר|תתקשרי|תחזרו|תחזור|תחזרי)\s+אליי?(?:\s+עכשיו)?(?:\s+בבקשה)?|(?:(?:את|אתה)\s+)?(?:יכולה|יכול|יכולים|יכולות|תוכלו|תוכל|תוכלי)\s+להתקשר\s+אליי?(?:\s+עכשיו)?(?:\s+בבקשה)?|(?:אפשר\s+)?להתקשר\s+אליי?(?:\s+עכשיו)?|אפשר\s+(?:לקבל\s+)?שיחה\s+טלפונית(?:\s+עכשיו)?)[.!?\s]*$/iu;
  const englishRepresentative =
    /^(?:(?:(?:i(?:\s+would|['’]d)\s+like|i\s+want)\s+(?:a|an)|can\s+(?:a|an))\s+(?:representative|agent)\s+(?:to\s+)?call\s+me|(?:please\s+)?have\s+(?:a\s+)?(?:representative|agent|someone)\s+call\s+me)(?:\s+now)?(?:[,،]\s*please|\s+please)?[.!?\s]*$/iu;
  const hebrewRepresentative =
    /^(?:(?:(?:אני\s+)?(?:רוצה|אשמח)|אפשר)\s+ש(?:נציג|נציגה|מישהו|מישהי)\s+(?:יתקשר|תתקשר|יחזור|תחזור)\s+אליי?)(?:\s+עכשיו)?(?:[,،]\s*בבקשה|\s+בבקשה)?[.!?\s]*$/iu;
  return (
    english.test(request) ||
    hebrew.test(request) ||
    englishRepresentative.test(request) ||
    hebrewRepresentative.test(request)
  );
}

/**
 * Admit one customer-requested WhatsApp callback into the durable messaging
 * queue. The explicit inbound message is action-scoped consent when the contact
 * has not revoked voice contact; it never silently rewrites the contact's
 * persisted consent preference.
 */
export async function queueWhatsAppAutomaticCall(
  sql: postgres.TransactionSql,
  actorUserId: string,
  conversationId: string,
  triggerMessageId: string,
  idempotencyKey: string,
): Promise<AutomaticCallCommand> {
  if (
    idempotencyKey.length < 8 ||
    idempotencyKey.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/u.test(idempotencyKey)
  )
    throw new TypeError("automatic call idempotency key is invalid");

  const candidates = await sql<AutomaticCallCandidate[]>`
    SELECT conversation.contact_id, callback_identity.id AS contact_identity_id,
           callback_identity.normalized_value AS destination,
           conversation.ownership_epoch, trigger.content_text AS trigger_text,
           voice_agent.id AS agent_version_id, flow.id AS canonical_flow_version_id,
           node -> 'configuration' AS voice_configuration
    FROM messaging.conversations conversation
    JOIN messaging.channels channel
      ON channel.id = conversation.channel_id
     AND channel.tenant_id = conversation.tenant_id
     AND channel.provider = 'meta'
     AND channel.status = 'active'
    JOIN crm.contacts contact
      ON contact.id = conversation.contact_id
     AND contact.tenant_id = conversation.tenant_id
    JOIN messaging.messages trigger
      ON trigger.id = ${triggerMessageId}::uuid
     AND trigger.conversation_id = conversation.id
     AND trigger.direction = 'inbound'
     AND trigger.content_type = 'text'
     AND trigger.provider = 'meta'
    JOIN messaging.inbound_message_origins callback_origin
      ON callback_origin.tenant_id = conversation.tenant_id
     AND callback_origin.message_id = trigger.id
    JOIN crm.contact_channel_identities callback_identity
      ON callback_identity.id = callback_origin.contact_identity_id
     AND callback_identity.tenant_id = callback_origin.tenant_id
     AND callback_identity.contact_id = contact.id
     AND callback_identity.channel = 'whatsapp'
     AND callback_identity.validation_status = 'valid'
     AND callback_identity.normalized_value = callback_origin.sender_address
    JOIN automation.flow_versions flow
      ON flow.tenant_id = conversation.tenant_id
     AND flow.agent_profile_version_id = conversation.ai_agent_profile_version_id
     AND flow.published_at IS NOT NULL
     AND flow.validation_status = 'valid'
    JOIN automation.flow_definitions definition
      ON definition.id = flow.flow_definition_id
     AND definition.tenant_id = flow.tenant_id
      AND definition.archived_at IS NULL
      AND definition.channel_capabilities @> ARRAY['voice','whatsapp']::text[]
    JOIN agents.agent_profile_versions flow_agent
      ON flow_agent.id=flow.agent_profile_version_id
     AND flow_agent.tenant_id=flow.tenant_id
     AND flow_agent.published_at IS NOT NULL
     AND flow_agent.validation_status='valid'
     AND flow_agent.channel_capabilities @> definition.channel_capabilities
    CROSS JOIN LATERAL jsonb_array_elements(flow.definition -> 'nodes') node
    JOIN agents.agent_profile_versions voice_agent
      ON voice_agent.tenant_id=conversation.tenant_id
     AND voice_agent.published_at IS NOT NULL
     AND voice_agent.validation_status='valid'
     AND 'voice'=ANY(voice_agent.channel_capabilities)
     AND (
       (node #>> '{configuration,agentVersionId}' IS NULL
        AND voice_agent.id=conversation.ai_agent_profile_version_id)
       OR node #>> '{configuration,agentVersionId}'=voice_agent.id::text
     )
    WHERE conversation.id = ${conversationId}::uuid
      AND conversation.removed_from_inbox_at IS NULL
      AND conversation.ownership_mode = 'ai'
      AND conversation.ai_enabled_by_user_id = ${actorUserId}::uuid
      AND contact.lifecycle_status = 'active'
      AND contact.voice_consent <> 'revoked'
      AND node ->> 'type' = 'voice.call'
      AND platform.messaging_ai_actor_authorized(${actorUserId}::uuid)
      AND trigger.id=(SELECT latest.id FROM messaging.messages latest
        WHERE latest.conversation_id=conversation.id AND latest.direction='inbound'
        ORDER BY latest.created_at DESC,latest.updated_at DESC,latest.id DESC LIMIT 1)
      AND NOT EXISTS (
        SELECT 1 FROM ops.jobs recent
        WHERE recent.tenant_id = conversation.tenant_id
          AND recent.job_type = 'whatsapp.ai.call'
          AND recent.idempotency_key IS DISTINCT FROM ${idempotencyKey}
          AND recent.reference_id = conversation.id
          AND recent.status IN ('queued','running','retry','succeeded')
          AND recent.created_at > CURRENT_TIMESTAMP - INTERVAL '10 minutes'
      )
    ORDER BY flow.published_at DESC, flow.version DESC
    LIMIT 1
    -- Published agent versions are immutable and the messaging runtime is
    -- intentionally read-only for this table. Lock only the mutable records
    -- whose eligibility must stay stable while the durable call is queued.
    FOR SHARE OF conversation, contact, trigger
  `;
  const candidate = candidates[0];
  if (candidate === undefined)
    throw new TypeError(
      "automatic call policy or published flow is unavailable",
    );
  if (!explicitWhatsAppCallbackIntent(candidate.trigger_text))
    throw new TypeError(
      "automatic call requires explicit current callback intent",
    );
  if (
    candidate.voice_configuration === null ||
    typeof candidate.voice_configuration !== "object" ||
    Array.isArray(candidate.voice_configuration)
  )
    throw new TypeError("published voice action configuration is invalid");
  const configuration = candidate.voice_configuration as Readonly<
    Record<string, unknown>
  >;
  const flowId = configuration.flowId;
  const flowVersion = configuration.flowVersion;
  if (
    typeof flowId !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(flowId) ||
    typeof flowVersion !== "number" ||
    !Number.isInteger(flowVersion) ||
    flowVersion < 1
  )
    throw new TypeError("published voice action configuration is invalid");
  const available = await sql<
    { available: boolean }[]
  >`SELECT platform.voice_flow_available(${flowId}::uuid, ${flowVersion}) AS available`;
  if (available[0]?.available !== true)
    throw new TypeError("published retained voice flow is unavailable");

  const payload = {
    actorUserId,
    contactIdentityId: candidate.contact_identity_id,
    contactId: candidate.contact_id,
    conversationId,
    destination: candidate.destination,
    flowId,
    flowVersion,
    mode: "real",
    ownershipEpoch: candidate.ownership_epoch,
    agentVersionId: candidate.agent_version_id,
    canonicalFlowVersionId: candidate.canonical_flow_version_id,
    triggerMessageId,
  } as const;
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO ops.jobs
      (tenant_id, queue, job_type, reference_type, reference_id, payload,
       idempotency_key, max_attempts, callback_trigger_message_id,
       callback_sender_identity_id, callback_destination)
    VALUES (platform.current_tenant_id(), 'messaging', 'whatsapp.ai.call',
            'conversation', ${conversationId}::uuid,
            ${sql.json(databaseJson(payload))}, ${idempotencyKey}, 3,
            ${triggerMessageId}::uuid, ${candidate.contact_identity_id}::uuid,
            ${candidate.destination})
    ON CONFLICT DO NOTHING RETURNING id
  `;
  const created = inserted[0] !== undefined;
  const rows = created
    ? inserted
    : await sql<{ id: string }[]>`
        SELECT id FROM ops.jobs
        WHERE tenant_id = platform.current_tenant_id()
          AND queue = 'messaging' AND job_type = 'whatsapp.ai.call'
          AND reference_id = ${conversationId}::uuid
          AND callback_trigger_message_id = ${triggerMessageId}::uuid
          AND callback_sender_identity_id = ${candidate.contact_identity_id}::uuid
          AND callback_destination = ${candidate.destination}
          AND payload = ${sql.json(databaseJson(payload))}::jsonb
        LIMIT 1
      `;
  const job = rows[0];
  if (job === undefined)
    throw new TypeError(
      "callback authorization belongs to different call work",
    );
  if (created)
    await auditAction(
      sql,
      actorUserId,
      "conversation.call_queued",
      "job",
      job.id,
      {
        conversationId,
        consentSource: "explicit_whatsapp_request",
        flowId,
        flowVersion,
      },
    );
  return { flowId, flowVersion, jobId: job.id, queued: created };
}

export interface HandoffSummary {
  readonly id: string;
  readonly contactId: string;
  readonly sourceChannel: SupportedChannel;
  readonly reasonSafe: string;
  readonly status: "pending" | "accepted" | "resolved" | "cancelled";
  readonly assignedUserId: string | null;
  readonly requestedAt: string;
}

interface HandoffRow {
  id: string;
  contact_id: string;
  source_channel: SupportedChannel;
  reason_safe: string;
  status: HandoffSummary["status"];
  assigned_user_id: string | null;
  requested_at: Date;
}

function mapHandoff(row: HandoffRow): HandoffSummary {
  return {
    id: row.id,
    contactId: row.contact_id,
    sourceChannel: row.source_channel,
    reasonSafe: row.reason_safe,
    status: row.status,
    assignedUserId: row.assigned_user_id,
    requestedAt: row.requested_at.toISOString(),
  };
}

export interface HandoffIdentityReferences {
  readonly flowRunId?: string | null;
  readonly conversationId?: string | null;
  readonly sessionId?: string | null;
}

export async function requestHandoff(
  sql: postgres.TransactionSql,
  actorUserId: string,
  contactId: string,
  sourceChannel: SupportedChannel,
  reasonSafe: string,
  idempotencyKey: string,
  references: HandoffIdentityReferences = {},
): Promise<HandoffSummary> {
  const reason = reasonSafe.trim();
  if (!reason || reason.length > 500)
    throw new TypeError("handoff reason must contain 1-500 safe characters");
  // Preserve the handoff receipt's idempotency contract before validating a
  // conversation reference. A conflicting replay must still be rejected as an
  // idempotency conflict, even when one of its altered references is invalid.
  // The INSERT below remains the authority for exact replay versus conflict;
  // this read only determines whether we are admitting genuinely new work.
  const existingReceipts = await sql<{ id: string }[]>`
    SELECT id FROM automation.handoffs
    WHERE idempotency_key = ${idempotencyKey}
    LIMIT 1
  `;
  if (
    existingReceipts[0] === undefined &&
    references.conversationId !== null &&
    references.conversationId !== undefined
  ) {
    const conversations = await sql<{ id: string }[]>`
      SELECT id FROM messaging.conversations
      WHERE id = ${references.conversationId}::uuid
        AND contact_id = ${contactId}::uuid
        AND removed_from_inbox_at IS NULL
      FOR SHARE
    `;
    if (conversations[0] === undefined)
      throw new TypeError("conversation is unavailable");
  }
  const rows = await sql<HandoffRow[]>`
    INSERT INTO automation.handoffs
      (tenant_id, contact_id, requested_by_user_id, source_channel,
       reason_safe, idempotency_key, flow_run_id, conversation_id, session_id)
    VALUES (platform.current_tenant_id(), ${contactId}::uuid,
            ${actorUserId}::uuid, ${sourceChannel}, ${reason}, ${idempotencyKey},
            ${references.flowRunId ?? null}::uuid,
            ${references.conversationId ?? null}::uuid,
            ${references.sessionId ?? null}::uuid)
    ON CONFLICT (tenant_id, idempotency_key)
    DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
    WHERE handoffs.contact_id = EXCLUDED.contact_id
      AND handoffs.requested_by_user_id IS NOT DISTINCT FROM EXCLUDED.requested_by_user_id
      AND handoffs.source_channel = EXCLUDED.source_channel
      AND handoffs.reason_safe = EXCLUDED.reason_safe
      AND handoffs.flow_run_id IS NOT DISTINCT FROM EXCLUDED.flow_run_id
      AND handoffs.conversation_id IS NOT DISTINCT FROM EXCLUDED.conversation_id
      AND handoffs.session_id IS NOT DISTINCT FROM EXCLUDED.session_id
    RETURNING id, contact_id, source_channel, reason_safe, status,
              assigned_user_id, requested_at
  `;
  const row = rows[0];
  if (row === undefined)
    throw Object.assign(
      new Error("idempotency key belongs to different handoff work"),
      { code: "23505" },
    );
  await auditAction(sql, actorUserId, "handoff.requested", "handoff", row.id, {
    sourceChannel,
  });
  return mapHandoff(row);
}

export async function transitionHandoff(
  sql: postgres.TransactionSql,
  handoffId: string,
  actorUserId: string,
  action: "accept" | "resolve" | "cancel",
): Promise<HandoffSummary> {
  const rows = await sql<HandoffRow[]>`
    UPDATE automation.handoffs
    SET status = CASE ${action}
          WHEN 'accept' THEN 'accepted'
          WHEN 'resolve' THEN 'resolved'
          ELSE 'cancelled'
        END,
        assigned_user_id = CASE WHEN ${action} = 'accept'
          THEN ${actorUserId}::uuid ELSE assigned_user_id END,
        accepted_at = CASE WHEN ${action} = 'accept'
          THEN CURRENT_TIMESTAMP ELSE accepted_at END,
        resolved_at = CASE WHEN ${action} IN ('resolve', 'cancel')
          THEN CURRENT_TIMESTAMP ELSE resolved_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${handoffId}::uuid
      AND (conversation_id IS NULL OR EXISTS (
        SELECT 1 FROM messaging.conversations conversation
        WHERE conversation.id = automation.handoffs.conversation_id
          AND conversation.removed_from_inbox_at IS NULL
      ))
      AND ((${action} = 'accept' AND status = 'pending')
        OR (${action} IN ('resolve', 'cancel') AND status IN ('pending','accepted')))
    RETURNING id, contact_id, source_channel, reason_safe, status,
              assigned_user_id, requested_at
  `;
  const row = rows[0];
  if (row === undefined) throw new TypeError("invalid handoff transition");
  await auditAction(sql, actorUserId, `handoff.${action}`, "handoff", row.id);
  return mapHandoff(row);
}

export async function listHandoffs(
  sql: postgres.TransactionSql,
): Promise<readonly HandoffSummary[]> {
  const rows = await sql<HandoffRow[]>`
    SELECT id, contact_id, source_channel, reason_safe, status,
           assigned_user_id, requested_at
    FROM automation.handoffs
    WHERE conversation_id IS NULL OR EXISTS (
      SELECT 1 FROM messaging.conversations conversation
      WHERE conversation.id = automation.handoffs.conversation_id
        AND conversation.removed_from_inbox_at IS NULL
    )
    ORDER BY requested_at DESC, id DESC LIMIT 100
  `;
  return rows.map(mapHandoff);
}

export interface ContactActivity {
  readonly eventId: string;
  readonly sourceType: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export async function listContactActivity(
  sql: postgres.TransactionSql,
  contactId: string,
): Promise<readonly ContactActivity[]> {
  const rows = await sql<
    {
      event_id: string;
      source_type: string;
      event_type: string;
      occurred_at: Date;
      metadata: Readonly<Record<string, JsonValue>>;
    }[]
  >`
    SELECT event_id, source_type, event_type, occurred_at, metadata
    FROM platform.contact_activity WHERE contact_id = ${contactId}::uuid
    ORDER BY occurred_at DESC, event_id DESC LIMIT 100
  `;
  return rows.map((row) => ({
    eventId: row.event_id,
    sourceType: row.source_type,
    eventType: row.event_type,
    occurredAt: row.occurred_at.toISOString(),
    metadata: row.metadata,
  }));
}

export interface CrossChannelUsage {
  readonly agentEvents: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly averageLatencyMs: number | null;
  readonly voiceSessions: number;
  readonly messagingJobs: number;
  readonly unpricedEvents: number;
  readonly estimatedCostUsd: null;
}

export async function summarizeCrossChannelUsage(
  sql: postgres.TransactionSql,
): Promise<CrossChannelUsage> {
  const rows = await sql<
    {
      agent_events: number;
      input_tokens: number;
      output_tokens: number;
      average_latency_ms: number | null;
      voice_sessions: number;
      messaging_jobs: number;
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM agents.usage_events) AS agent_events,
      (SELECT COALESCE(sum(input_tokens), 0)::int FROM agents.usage_events)
        AS input_tokens,
      (SELECT COALESCE(sum(output_tokens), 0)::int FROM agents.usage_events)
        AS output_tokens,
      (SELECT round(avg(latency_ms))::int FROM agents.usage_events
       WHERE latency_ms IS NOT NULL) AS average_latency_ms,
      (SELECT count(session_id)::int FROM public.sessions) AS voice_sessions,
      (SELECT count(*)::int FROM ops.jobs WHERE queue = 'messaging')
        AS messaging_jobs
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("usage summary failed");
  return {
    agentEvents: row.agent_events,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    averageLatencyMs: row.average_latency_ms,
    voiceSessions: row.voice_sessions,
    messagingJobs: row.messaging_jobs,
    unpricedEvents: row.agent_events,
    estimatedCostUsd: null,
  };
}
