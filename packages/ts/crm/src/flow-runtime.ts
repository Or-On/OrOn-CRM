import type postgres from "postgres";
import {
  compileCanonicalFlow,
  parseCanonicalFlow,
  publishCanonicalFlow,
  queueWhatsAppTriggeredCall,
  requestHandoff,
  type CanonicalFlow,
  type SupportedChannel,
} from "./cross-channel.js";
import {
  configurationText,
  executablePath,
  interpolateAutomation,
  templateParameters,
} from "./flow-adapters.js";
import { queueWhatsAppOutbound } from "./whatsapp-outbound.js";
import type { JsonValue } from "./types.js";

export async function validateRetainedReferences(
  sql: postgres.TransactionSql,
  flow: CanonicalFlow,
) {
  for (const channel of flow.channels)
    for (const node of executablePath(flow, channel)) {
      if (node.type !== "voice.call") continue;
      const cfg = node.configuration ?? {};
      const rows = await sql<
        { available: boolean }[]
      >`SELECT platform.voice_flow_available(
      ${configurationText(cfg, "flowId")}::uuid, ${Number(cfg.flowVersion)}::integer) AS available`;
      if (!rows[0]?.available)
        throw new TypeError("retained voice flow version is unavailable");
      if (cfg.agentVersionId === undefined) continue;
      const agentVersionId = configurationText(cfg, "agentVersionId");
      const agents = await sql<{ available: boolean }[]>`SELECT EXISTS (
          SELECT 1 FROM agents.agent_profile_versions agent
          WHERE agent.tenant_id=platform.current_tenant_id()
            AND agent.id=${agentVersionId}::uuid
            AND agent.published_at IS NOT NULL
            AND agent.validation_status='valid'
            AND agent.channel_capabilities @> ARRAY['voice']::text[]
        ) AS available`;
      if (!agents[0]?.available)
        throw new TypeError("pinned voice agent version is unavailable");
    }
}

export interface SavedCanonicalFlowDraft {
  readonly version: number;
  readonly versionId: string;
}

/**
 * Persists an editor save as a new immutable draft row. The definition lock
 * serializes version allocation while RLS and the explicit tenant predicate
 * keep the operation tenant-local. Existing drafts and published versions are
 * never updated in place.
 */
export async function saveCanonicalFlowDraft(
  sql: postgres.TransactionSql,
  actorUserId: string,
  definitionId: string,
  candidate: unknown,
): Promise<SavedCanonicalFlowDraft | null> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(definitionId))
    throw new TypeError("invalid flow identifier");

  const flow = parseCanonicalFlow(candidate);
  for (const channel of flow.channels) executablePath(flow, channel);
  const compiled = compileCanonicalFlow(flow);

  const definitions = await sql<{ id: string }[]>`
    SELECT id FROM automation.flow_definitions
    WHERE tenant_id=platform.current_tenant_id()
      AND id=${definitionId}::uuid AND archived_at IS NULL
    FOR UPDATE
  `;
  if (definitions[0] === undefined) return null;

  const latestVersions = await sql<
    {
      agent_profile_version_id: string | null;
      version: number;
    }[]
  >`
    SELECT version, agent_profile_version_id
    FROM automation.flow_versions
    WHERE tenant_id=platform.current_tenant_id()
      AND flow_definition_id=${definitionId}::uuid
    ORDER BY version DESC LIMIT 1
  `;
  const latest = latestVersions[0];
  if (latest?.agent_profile_version_id === null || latest === undefined)
    throw new TypeError("only canonical flows can be edited");

  const version = latest.version + 1;
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO automation.flow_versions
      (tenant_id, flow_definition_id, version, schema_version, definition,
       validation_status, validation_errors, agent_profile_version_id,
       compiled_adapters, created_by_user_id)
    VALUES (platform.current_tenant_id(), ${definitionId}::uuid, ${version}, '1.0',
            ${sql.json(JSON.parse(JSON.stringify(flow)) as postgres.JSONValue)},
            'valid', NULL, ${latest.agent_profile_version_id}::uuid,
            ${sql.json(JSON.parse(JSON.stringify(compiled)) as postgres.JSONValue)},
            ${actorUserId}::uuid)
    RETURNING id
  `;
  const versionId = inserted[0]?.id;
  if (versionId === undefined) throw new Error("flow version insert failed");

  // This timestamp is definition metadata used to order the flow library.
  // Runtime channel capabilities remain the last published version's contract
  // and are updated only by publishCanonicalFlow.
  await sql`
    UPDATE automation.flow_definitions
    SET updated_at=CURRENT_TIMESTAMP
    WHERE tenant_id=platform.current_tenant_id()
      AND id=${definitionId}::uuid
  `;

  await sql`
    INSERT INTO audit.records
      (tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (platform.current_tenant_id(), ${actorUserId}::uuid,
            'flow.draft_saved', 'flow_definition', ${definitionId}::uuid,
            ${sql.json({
              basedOnVersion: latest.version,
              channels: [...flow.channels],
              version,
              versionId,
            })})
  `;
  return { version, versionId };
}

export async function publishExecutableFlow(
  sql: postgres.TransactionSql,
  actor: string,
  definitionId: string,
): Promise<boolean> {
  const rows = await sql<
    { definition: unknown }[]
  >`SELECT definition FROM automation.flow_versions
    WHERE flow_definition_id=${definitionId}::uuid AND published_at IS NULL
    ORDER BY version DESC LIMIT 1 FOR UPDATE`;
  if (!rows[0]) return false;
  await validateRetainedReferences(sql, parseCanonicalFlow(rows[0].definition));
  return publishCanonicalFlow(sql, actor, definitionId);
}

export async function queueCanonicalSimulation(
  sql: postgres.TransactionSql,
  actor: string,
  definitionId: string,
  conversationId: string,
  channel: SupportedChannel,
  key: string,
): Promise<string> {
  if (key.length < 8 || key.length > 128)
    throw new TypeError("invalid simulation idempotency key");
  if (
    !(
      await sql<
        { allowed: boolean }[]
      >`SELECT platform.canonical_actor_authorized() AS allowed`
    )[0]?.allowed
  )
    throw new TypeError("active flow-management membership required");
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(platform.current_tenant_id()::text || ${key}, 6))`;
  const prior = await sql<
    { id: string; trigger_metadata: Record<string, string> }[]
  >`SELECT id, trigger_metadata
    FROM automation.flow_runs WHERE trigger_type='canonical.simulator'
      AND trigger_metadata->>'idempotencyKey'=${key}`;
  if (prior[0]) {
    const previous = prior[0].trigger_metadata;
    if (
      previous.definitionId !== definitionId ||
      previous.conversationId !== conversationId ||
      previous.channel !== channel ||
      previous.actorUserId !== actor
    )
      throw new TypeError("simulation idempotency key conflict");
    return prior[0].id;
  }
  const versions = await sql<
    { id: string; definition: unknown; channel_capabilities: string[] }[]
  >`
    SELECT flow.id, flow.definition, agent.channel_capabilities
    FROM automation.flow_versions flow
    JOIN automation.flow_definitions definition
      ON definition.id=flow.flow_definition_id
     AND definition.tenant_id=flow.tenant_id
     AND definition.archived_at IS NULL
    JOIN agents.agent_profile_versions agent
      ON agent.id=flow.agent_profile_version_id AND agent.tenant_id=flow.tenant_id
    WHERE flow.flow_definition_id=${definitionId}::uuid AND flow.published_at IS NOT NULL
      AND agent.published_at IS NOT NULL
      AND agent.validation_status='valid'
      AND agent.channel_capabilities @> definition.channel_capabilities
    ORDER BY flow.version DESC LIMIT 1`;
  const version = versions[0];
  if (!version?.channel_capabilities.includes(channel))
    throw new TypeError("published compatible agent and flow required");
  const flow = parseCanonicalFlow(version.definition);
  executablePath(flow, channel);
  await validateRetainedReferences(sql, flow);
  const contacts = await sql<
    { contact_id: string }[]
  >`SELECT contact_id FROM messaging.conversations
    WHERE id=${conversationId}::uuid
      AND removed_from_inbox_at IS NULL
    FOR SHARE`;
  if (!contacts[0]) throw new TypeError("conversation is unavailable");
  const metadata = {
    mode: "simulator",
    actorUserId: actor,
    conversationId,
    channel,
    definitionId,
    idempotencyKey: key,
  };
  const runs = await sql<{ id: string }[]>`INSERT INTO automation.flow_runs
    (tenant_id, flow_version_id, contact_id, trigger_type, trigger_metadata, status, started_at)
    VALUES (platform.current_tenant_id(), ${version.id}::uuid, ${contacts[0].contact_id}::uuid,
      'canonical.simulator', ${sql.json(metadata)}, 'running', CURRENT_TIMESTAMP) RETURNING id`;
  const id = runs[0]?.id;
  if (!id) throw new Error("flow run insert failed");
  await sql`INSERT INTO ops.jobs(tenant_id, queue, job_type, reference_type, reference_id, payload, idempotency_key)
    VALUES(platform.current_tenant_id(), 'messaging', 'cross_channel.flow.simulated', 'flow_run',
      ${id}::uuid, '{"mode":"simulator"}', ${`flow:${id}`})`;
  return id;
}

/** One bounded orchestration tick; durable child jobs stay in their existing engines. */
export async function advanceCanonicalSimulation(
  sql: postgres.TransactionSql,
  runId: string,
): Promise<boolean> {
  const rows = await sql<
    {
      id: string;
      contact_id: string;
      definition: unknown;
      status: string;
      trigger_metadata: Record<string, string>;
      expired: boolean;
      variables: Record<string, JsonValue>;
    }[]
  >`
    SELECT run.*, version.definition, run.created_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes' AS expired
    FROM automation.flow_runs run JOIN automation.flow_versions version ON version.id=run.flow_version_id
    WHERE run.id=${runId}::uuid AND run.trigger_type='canonical.simulator' FOR UPDATE OF run`;
  const run = rows[0];
  if (!run) throw new TypeError("canonical simulation is unavailable");
  if (run.status === "succeeded") return true;
  if (["failed", "cancelled"].includes(run.status) || run.expired)
    throw new TypeError("canonical simulation expired or stopped");
  const actor = run.trigger_metadata.actorUserId;
  const conversation = run.trigger_metadata.conversationId;
  const channel = run.trigger_metadata.channel;
  if (!actor || !conversation || !["voice", "whatsapp"].includes(channel ?? ""))
    throw new TypeError("invalid simulation context");
  await sql`SELECT set_config('app.current_user', ${actor}, true)`;
  if (
    !(
      await sql<
        { allowed: boolean }[]
      >`SELECT platform.canonical_actor_authorized() AS allowed`
    )[0]?.allowed
  )
    throw new TypeError("flow actor no longer authorized");
  const conversations = await sql<{ id: string }[]>`
    SELECT id FROM messaging.conversations
    WHERE id = ${conversation}::uuid
      AND removed_from_inbox_at IS NULL
    FOR UPDATE
  `;
  if (conversations[0] === undefined)
    throw new TypeError("conversation is unavailable");
  const path = executablePath(
    parseCanonicalFlow(run.definition),
    channel as SupportedChannel,
  );
  for (const node of path) {
    const previous = (
      await sql<{ status: string; output_metadata: { jobId?: string } }[]>`
      SELECT status, output_metadata FROM automation.flow_step_runs WHERE flow_run_id=${runId}::uuid AND step_key=${node.id}`
    )[0];
    if (previous?.status === "succeeded") continue;
    if (previous?.status === "waiting") {
      const child = (
        await sql<
          { status: string }[]
        >`SELECT status FROM ops.jobs WHERE id=${previous.output_metadata.jobId ?? ""}::uuid`
      )[0];
      if (!child || ["dead", "cancelled"].includes(child.status))
        throw new TypeError("simulation child action failed");
      if (child.status !== "succeeded") return false;
      await sql`UPDATE automation.flow_step_runs SET status='succeeded', completed_at=CURRENT_TIMESTAMP
        WHERE flow_run_id=${runId}::uuid AND step_key=${node.id}`;
      continue;
    }
    const cfg = node.configuration ?? {};
    let jobId: string | undefined;
    const key = `flow:${runId}:${node.id}`;
    switch (node.type) {
      case "start":
      case "end":
        break;
      case "crm.update": {
        const field = configurationText(cfg, "field"); // allow-list validated by executablePath
        const value = interpolateAutomation(
          configurationText(cfg, "value"),
          run.variables,
        );
        const updated =
          await sql`UPDATE crm.contacts SET ${sql(field)}=${value}, updated_at=CURRENT_TIMESTAMP
          WHERE id=${run.contact_id}::uuid AND lifecycle_status='active' RETURNING id`;
        if (!updated.length) throw new TypeError("active contact required");
        break;
      }
      case "handoff":
        await requestHandoff(
          sql,
          actor,
          run.contact_id,
          channel as SupportedChannel,
          configurationText(cfg, "reason"),
          key,
          { flowRunId: runId, conversationId: conversation },
        );
        break;
      case "voice.call":
        jobId = (
          await queueWhatsAppTriggeredCall(sql, actor, conversation, key, {
            flowId: configurationText(cfg, "flowId"),
            flowVersion: Number(cfg.flowVersion),
          })
        ).jobId;
        break;
      case "message.send": {
        const common = {
          conversationId: conversation,
          senderUserId: actor,
          provider: "simulator" as const,
          realProviderEnabled: false,
          explicitlyConfirmed: false,
          idempotencyKey: key,
        };
        const request = await queueWhatsAppOutbound(
          sql,
          cfg.kind === "template"
            ? {
                ...common,
                kind: "template",
                templateName: configurationText(cfg, "template_name"),
                language: configurationText(cfg, "language"),
                parameters: templateParameters(cfg.variables),
              }
            : {
                ...common,
                kind: "text",
                text: interpolateAutomation(
                  configurationText(cfg, "text"),
                  run.variables,
                ),
              },
        );
        jobId = (
          await sql<
            { id: string }[]
          >`SELECT id FROM ops.jobs WHERE reference_id=${request.requestId}::uuid AND job_type='whatsapp.outbound.send'`
        )[0]?.id;
        if (!jobId) throw new Error("durable message job missing");
        break;
      }
    }
    await sql`INSERT INTO automation.flow_step_runs(tenant_id,flow_run_id,step_key,status,output_metadata,completed_at)
      VALUES(platform.current_tenant_id(),${runId}::uuid,${node.id},${jobId ? "waiting" : "succeeded"},
        ${sql.json(jobId ? { jobId } : {})},${jobId ? null : new Date()})`;
    await sql`UPDATE automation.flow_runs SET current_step_key=${node.id}, status=${jobId ? "waiting" : "running"} WHERE id=${runId}::uuid`;
    if (jobId) return false;
  }
  await sql`UPDATE automation.flow_runs SET status='succeeded', completed_at=CURRENT_TIMESTAMP WHERE id=${runId}::uuid`;
  return true;
}
