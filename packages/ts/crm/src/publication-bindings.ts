import { createHash } from "node:crypto";
import type postgres from "postgres";
import {
  publishAgentProfile,
  parseCanonicalFlow,
  compileCanonicalFlow,
  parseReferencePolicy,
  type CanonicalFlow,
} from "./cross-channel.js";
import {
  publishExecutableFlow,
  validateRetainedReferences,
} from "./flow-runtime.js";
import { assertKnowledgeManager } from "./knowledge.js";
import { assertAgentGoldenPublishable } from "./agent-quality-gate.js";
import {
  getTenantConfigurationState,
  parseTenantConfiguration,
  saveTenantConfigurationDraft,
  transitionTenantConfiguration,
  validateTenantConfiguration,
} from "./tenant-configuration.js";
import type { TenantProcessInput } from "./tenant-processes.js";
import type { JsonValue } from "./types.js";

export type PublicationStatus =
  | "active_for_new_interactions"
  | "published_pending_activation"
  | "unchanged_pinned"
  | "blocked_evaluation";
export interface PublicationImpact {
  readonly processName: string;
  readonly trigger: string;
  readonly status: PublicationStatus;
  readonly reason: string;
  readonly oldAgentVersionId: string | null;
  readonly newAgentVersionId: string | null;
  readonly oldFlowVersionId: string | null;
  readonly newFlowVersionId: string | null;
}
export interface PublicationResult {
  readonly evaluationCandidates?: readonly {
    agentProfileId: string;
    agentVersionId: string;
    publicationOperationId: string;
    candidateDigest: string;
  }[];
  readonly status: PublicationStatus;
  readonly operationId: string;
  readonly releaseId: string | null;
  readonly impacts: readonly PublicationImpact[];
}
export class PublicationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationConflictError";
  }
}
interface Operation {
  kind: "agent" | "retained_voice" | "canonical";
  resource_id: string;
  candidate_id: string | null;
  candidate_version: number | null;
  request_hash: string;
  result: PublicationResult & { retainedResult?: JsonValue };
}
interface PublishedSource {
  id: string;
  flow_definition_id: string;
  version: number;
  definition: unknown;
  agent_profile_version_id: string;
  archived_at: Date | null;
}
function json(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function requiredCandidate(value: string | null): string {
  if (value === null) throw new TypeError("Publication candidate ID missing");
  return value;
}
function uuid(value: string) {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(value))
    throw new TypeError("A UUID is required");
}
async function lock(sql: postgres.TransactionSql) {
  await assertKnowledgeManager(sql);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('tenant-configuration:' || platform.current_tenant_id()::text,0))`;
}

async function candidateEvaluation(
  sql: postgres.TransactionSql,
  operationId: string,
): Promise<PublicationResult | null> {
  const [gate] = await sql<
    { enabled: boolean }[]
  >`SELECT platform.current_agent_quality_gate_enabled() AS enabled`;
  if (!gate?.enabled) return null;
  const [prepared] = await sql<
    {
      value: {
        digest: string;
        agents: { agentProfileId: string; agentVersionId: string }[];
      };
    }[]
  >`SELECT platform.prepare_publication_evaluation(${operationId}::uuid) AS value`;
  if (!prepared) throw new Error("Publication candidate snapshot missing");
  const [evidence] = await sql<
    { allowed: boolean }[]
  >`SELECT platform.publication_evaluation_satisfied(${operationId}::uuid) AS allowed`;
  if (evidence?.allowed) return null;
  const [prior] = await sql<
    { result: PublicationResult }[]
  >`SELECT result FROM automation.publication_operations WHERE id=${operationId}::uuid`;
  const result: PublicationResult = {
    status: "blocked_evaluation",
    operationId,
    releaseId: prior?.result.releaseId ?? null,
    impacts: [],
    evaluationCandidates: prepared.value.agents.map((agent) => ({
      ...agent,
      publicationOperationId: operationId,
      candidateDigest: prepared.value.digest,
    })),
  };
  await sql`UPDATE automation.publication_operations SET result=result || ${sql.json(json(result))} WHERE id=${operationId}::uuid`;
  return result;
}
async function stageCandidate(
  sql: postgres.TransactionSql,
  actor: string,
  id: string,
  kind: "agent" | "canonical",
  resource: string,
  candidate: string,
  hash: string,
): Promise<PublicationResult | null> {
  const [gate] = await sql<
    { enabled: boolean }[]
  >`SELECT platform.current_agent_quality_gate_enabled() AS enabled`;
  if (!gate?.enabled) return null;
  await sql`INSERT INTO automation.publication_operations(tenant_id,id,kind,resource_id,candidate_id,request_hash,result,created_by_user_id) VALUES(platform.current_tenant_id(),${id}::uuid,${kind},${resource}::uuid,${candidate}::uuid,${hash},${sql.json({ status: "blocked_evaluation", operationId: id, releaseId: null, impacts: [] })},${actor}::uuid)`;
  return candidateEvaluation(sql, id);
}

/** Caller owns one transaction: publication, follower clones and approved release commit together. */
export async function publishAgentWithBindings(
  sql: postgres.TransactionSql,
  actor: string,
  profileId: string,
  command: { expectedVersionId: string; requestId: string; activate: boolean },
): Promise<PublicationResult> {
  uuid(command.requestId);
  uuid(command.expectedVersionId);
  uuid(profileId);
  await lock(sql);
  const hash = digest({ profileId, ...command });
  const [prior] = await sql<
    Operation[]
  >`SELECT kind,resource_id,candidate_id,candidate_version,request_hash,result FROM automation.publication_operations WHERE id=${command.requestId}::uuid`;
  if (prior) {
    if (prior.request_hash !== hash)
      throw new PublicationConflictError(
        "Publication request ID was reused for another candidate",
      );
    return prior.result;
  }
  const [latest] = await sql<
    { id: string; published_at: Date | null }[]
  >`SELECT v.id,v.published_at FROM agents.agent_profile_versions v JOIN agents.agent_profiles p ON p.id=v.agent_profile_id WHERE p.id=${profileId}::uuid AND p.archived_at IS NULL ORDER BY v.version DESC LIMIT 1 FOR UPDATE OF p`;
  if (latest?.id !== command.expectedVersionId || latest.published_at !== null)
    throw new PublicationConflictError(
      "Agent candidate changed before publication",
    );
  const evaluation = await stageCandidate(
    sql,
    actor,
    command.requestId,
    "agent",
    profileId,
    command.expectedVersionId,
    hash,
  );
  if (evaluation) return evaluation;
  const published = await publishAgentProfile(
    sql,
    actor,
    profileId,
    command.expectedVersionId,
  );
  if (!published)
    throw new PublicationConflictError(
      "No current valid unpublished agent version exists",
    );
  const result = await propagate(
    sql,
    actor,
    command.requestId,
    {
      kind: "agent",
      resource_id: profileId,
      candidate_id: command.expectedVersionId,
      candidate_version: null,
    },
    command.activate,
  );
  await sql`INSERT INTO automation.publication_operations(tenant_id,id,kind,resource_id,candidate_id,request_hash,result,created_by_user_id)
    VALUES(platform.current_tenant_id(),${command.requestId}::uuid,'agent',${profileId}::uuid,${command.expectedVersionId}::uuid,${hash},${sql.json(json(result))},${actor}::uuid) ON CONFLICT(tenant_id,id) DO UPDATE SET result=EXCLUDED.result`;
  return result;
}

/** Canonical editor publication uses the same reviewed release boundary. */
export async function publishCanonicalWithBindings(
  sql: postgres.TransactionSql,
  actor: string,
  definitionId: string,
  command: { expectedVersionId: string; requestId: string; activate: boolean },
): Promise<PublicationResult> {
  uuid(command.requestId);
  uuid(command.expectedVersionId);
  uuid(definitionId);
  await lock(sql);
  const hash = digest({ definitionId, ...command });
  const [prior] = await sql<
    Operation[]
  >`SELECT kind,resource_id,candidate_id,candidate_version,request_hash,result FROM automation.publication_operations WHERE id=${command.requestId}::uuid`;
  if (prior) {
    if (prior.request_hash !== hash)
      throw new PublicationConflictError("Publication request ID conflict");
    return prior.result;
  }
  const [latest] = await sql<
    { id: string }[]
  >`SELECT v.id FROM automation.flow_versions v JOIN automation.flow_definitions d ON d.id=v.flow_definition_id WHERE d.id=${definitionId}::uuid AND d.archived_at IS NULL ORDER BY v.version DESC LIMIT 1 FOR UPDATE OF d`;
  if (latest?.id !== command.expectedVersionId)
    throw new PublicationConflictError(
      "Flow version changed; reload before publishing",
    );
  const evaluation = await stageCandidate(
    sql,
    actor,
    command.requestId,
    "canonical",
    definitionId,
    command.expectedVersionId,
    hash,
  );
  if (evaluation) return evaluation;
  if (!(await publishExecutableFlow(sql, actor, definitionId)))
    throw new TypeError("A valid unpublished canonical flow is required");
  const result = await propagate(
    sql,
    actor,
    command.requestId,
    {
      kind: "canonical",
      resource_id: definitionId,
      candidate_id: command.expectedVersionId,
      candidate_version: null,
    },
    command.activate,
  );
  await sql`INSERT INTO automation.publication_operations(tenant_id,id,kind,resource_id,candidate_id,request_hash,result,created_by_user_id) VALUES(platform.current_tenant_id(),${command.requestId}::uuid,'canonical',${definitionId}::uuid,${command.expectedVersionId}::uuid,${hash},${sql.json(json(result))},${actor}::uuid) ON CONFLICT(tenant_id,id) DO UPDATE SET result=EXCLUDED.result`;
  return result;
}

/** A retained source publication is durable pending work. This explicit action resumes safely after a crash. */
export async function activateRetainedPublication(
  sql: postgres.TransactionSql,
  actor: string,
  operationId: string,
  activate: boolean,
): Promise<PublicationResult> {
  uuid(operationId);
  await lock(sql);
  const [operation] = await sql<
    Operation[]
  >`SELECT kind,resource_id,candidate_id,candidate_version,request_hash,result FROM automation.publication_operations WHERE id=${operationId}::uuid FOR UPDATE`;
  if (!operation) throw new TypeError("Publication not found");
  if (operation.result.releaseId) {
    if (
      (await getTenantConfigurationState(sql)).active?.id !==
      operation.result.releaseId
    ) {
      const evaluation = await candidateEvaluation(sql, operationId);
      if (evaluation)
        return { ...evaluation, releaseId: operation.result.releaseId };
    }
    const state = await getTenantConfigurationState(sql);
    if (
      activate &&
      state.draft?.id === operation.result.releaseId &&
      state.draft.status === "submitted"
    )
      await transitionTenantConfiguration(
        sql,
        "approve",
        state.draft.revision,
        "Reviewed publication activation",
        `publication:${operationId}:activate`,
      );
    const active =
      (await getTenantConfigurationState(sql)).active?.id ===
      operation.result.releaseId;
    const status: PublicationStatus = active
      ? "active_for_new_interactions"
      : "published_pending_activation";
    const result = {
      ...operation.result,
      status,
      impacts: operation.result.impacts.map((impact) =>
        impact.status === "unchanged_pinned" ? impact : { ...impact, status },
      ),
    };
    await sql`UPDATE automation.publication_operations SET result=${sql.json(json(result))} WHERE id=${operationId}::uuid`;
    return result;
  }
  if (
    !["published_pending_activation", "blocked_evaluation"].includes(
      operation.result.status,
    )
  )
    return operation.result;
  const evaluation = await candidateEvaluation(sql, operationId);
  if (evaluation) return evaluation;
  if (operation.kind === "agent") {
    if (
      !(await publishAgentProfile(
        sql,
        actor,
        operation.resource_id,
        requiredCandidate(operation.candidate_id),
      ))
    )
      throw new PublicationConflictError(
        "Agent candidate changed before activation",
      );
  } else if (operation.kind === "canonical") {
    const [latest] = await sql<
      { id: string }[]
    >`SELECT id FROM automation.flow_versions WHERE flow_definition_id=${operation.resource_id}::uuid ORDER BY version DESC LIMIT 1`;
    if (
      latest?.id !== operation.candidate_id ||
      !(await publishExecutableFlow(sql, actor, operation.resource_id))
    )
      throw new PublicationConflictError(
        "Canonical candidate changed before activation",
      );
  }
  const result = await propagate(sql, actor, operationId, operation, activate);
  await sql`UPDATE automation.publication_operations SET result=${sql.json(json({ ...result, retainedResult: operation.result.retainedResult }))} WHERE id=${operationId}::uuid`;
  return result;
}

async function propagate(
  sql: postgres.TransactionSql,
  actor: string,
  operationId: string,
  candidate: Pick<
    Operation,
    "kind" | "resource_id" | "candidate_id" | "candidate_version"
  >,
  activate: boolean,
): Promise<PublicationResult> {
  const state = await getTenantConfigurationState(sql);
  if (!state.active)
    throw new TypeError(
      "An approved active configuration is required before following publications",
    );
  if (state.draft)
    throw new PublicationConflictError(
      "Finish or reject the existing configuration review before publishing a following bundle",
    );
  const impacts: PublicationImpact[] = [];
  const next: TenantProcessInput[] = [];
  const clones = new Map<string, { id: string; agent: string }>();
  // Stable ordering prevents lock inversion across agent and retained publications.
  const sources = await sql<
    PublishedSource[]
  >`SELECT v.id,v.flow_definition_id,v.version,v.definition,v.agent_profile_version_id,d.archived_at
    FROM automation.flow_versions v JOIN automation.flow_definitions d ON d.id=v.flow_definition_id AND d.tenant_id=v.tenant_id
    WHERE v.tenant_id=platform.current_tenant_id() AND v.published_at IS NOT NULL ORDER BY d.id,v.id FOR UPDATE OF d`;
  const byId = new Map(sources.map((source) => [source.id, source]));
  for (const route of state.active.configuration.processes) {
    const source = byId.get(route.flowVersionId ?? "");
    if (!route.enabled || !source) {
      next.push(route);
      continue;
    }
    const flow = parseCanonicalFlow(source.definition);
    const relevant =
      candidate.kind === "canonical"
        ? source.flow_definition_id === candidate.resource_id
        : candidate.kind === "agent"
          ? (
              await sql<
                { id: string }[]
              >`SELECT id FROM agents.agent_profile_versions WHERE id=${route.agentProfileVersionId ?? null}::uuid AND agent_profile_id=${candidate.resource_id}::uuid`
            ).length > 0
          : flow.nodes.some(
              (node) =>
                node.type === "voice.call" &&
                node.configuration?.flowId === candidate.resource_id,
            );
    if (!relevant) {
      next.push(route);
      continue;
    }
    const voice =
      route.trigger.startsWith("voice.") || route.channel === "voice";
    let reason = source.archived_at
      ? "archived_flow"
      : parseReferencePolicy(route.bindingPolicy) === "pinned"
        ? "process_pinned"
        : candidate.kind === "agent" &&
            parseReferencePolicy(flow.agentReferencePolicy) === "pinned"
          ? "canonical_agent_pinned"
          : "";
    if (!reason && voice)
      for (const node of flow.nodes.filter(
        (node) => node.type === "voice.call",
      )) {
        const cfg = node.configuration ?? {};
        if (
          candidate.kind === "agent" &&
          cfg.agentVersionId !== undefined &&
          parseReferencePolicy(cfg.agentReferencePolicy) === "pinned"
        )
          reason = "node_agent_pinned";
        if (
          (candidate.kind === "agent" ||
            (candidate.kind === "retained_voice" &&
              cfg.flowId === candidate.resource_id)) &&
          parseReferencePolicy(cfg.flowReferencePolicy) === "pinned"
        )
          reason = "retained_flow_pinned";
      }
    if (reason) {
      next.push(route);
      impacts.push({
        processName: route.name,
        trigger: route.trigger,
        status: "unchanged_pinned",
        reason,
        oldAgentVersionId: route.agentProfileVersionId ?? null,
        newAgentVersionId: route.agentProfileVersionId ?? null,
        oldFlowVersionId: source.id,
        newFlowVersionId: source.id,
      });
      continue;
    }
    const agent =
      candidate.kind === "agent"
        ? requiredCandidate(candidate.candidate_id)
        : source.agent_profile_version_id;
    const key = `${source.id}:${agent}`;
    let clone = clones.get(key);
    if (candidate.kind === "canonical") {
      const target = byId.get(requiredCandidate(candidate.candidate_id));
      if (!target || target.archived_at)
        throw new TypeError("Published canonical candidate unavailable");
      clone = { id: target.id, agent: target.agent_profile_version_id };
      clones.set(key, clone);
      await validateRetainedReferences(
        sql,
        parseCanonicalFlow(target.definition),
      );
      await assertAgentGoldenPublishable(sql, clone.agent);
    }
    if (!clone) {
      const definition: CanonicalFlow = {
        ...flow,
        nodes: flow.nodes.map((node) => {
          if (node.type !== "voice.call") return node;
          const cfg = { ...node.configuration };
          if (
            candidate.kind === "retained_voice" &&
            cfg.flowId === candidate.resource_id &&
            parseReferencePolicy(cfg.flowReferencePolicy) === "follow_published"
          )
            cfg.flowVersion = candidate.candidate_version;
          if (
            candidate.kind === "agent" &&
            cfg.agentVersionId !== undefined &&
            parseReferencePolicy(cfg.agentReferencePolicy) ===
              "follow_published"
          )
            cfg.agentVersionId = agent;
          return { ...node, configuration: cfg };
        }),
      };
      await validateRetainedReferences(sql, definition);
      await assertAgentGoldenPublishable(sql, agent);
      const compiled = compileCanonicalFlow(definition);
      const [row] = await sql<
        { id: string }[]
      >`INSERT INTO automation.flow_versions(tenant_id,flow_definition_id,version,schema_version,definition,validation_status,agent_profile_version_id,compiled_adapters,created_by_user_id,published_at)
        SELECT platform.current_tenant_id(),${source.flow_definition_id}::uuid,coalesce(max(version),0)+1,'1.0',${sql.json(json(definition))},'valid',${agent}::uuid,${sql.json(json(compiled))},${actor}::uuid,CURRENT_TIMESTAMP
        FROM automation.flow_versions WHERE flow_definition_id=${source.flow_definition_id}::uuid RETURNING id`;
      if (!row) throw new Error("Canonical publication failed");
      clone = { id: row.id, agent };
      clones.set(key, clone);
    }
    next.push({
      ...route,
      agentProfileVersionId: clone.agent,
      flowVersionId: clone.id,
    });
    impacts.push({
      processName: route.name,
      trigger: route.trigger,
      status: "published_pending_activation",
      reason: "following_publication",
      oldAgentVersionId: route.agentProfileVersionId ?? null,
      newAgentVersionId: clone.agent,
      oldFlowVersionId: source.id,
      newFlowVersionId: clone.id,
    });
  }
  if (!clones.size)
    return {
      status: "unchanged_pinned",
      operationId,
      releaseId: null,
      impacts,
    };
  const configuration = parseTenantConfiguration({
    ...state.active.configuration,
    processes: next,
  });
  await validateTenantConfiguration(sql, configuration);
  await saveTenantConfigurationDraft(
    sql,
    configuration,
    null,
    `publication:${operationId}:draft`,
  );
  let draft = (await getTenantConfigurationState(sql)).draft;
  if (!draft) throw new Error("Publication review draft missing");
  await transitionTenantConfiguration(
    sql,
    "submit",
    draft.revision,
    "Publication follower bundle",
    `publication:${operationId}:submit`,
  );
  draft = (await getTenantConfigurationState(sql)).draft;
  if (!draft) throw new Error("Publication review submission missing");
  const [permission] = await sql<
    { allowed: boolean }[]
  >`SELECT platform.can_activate_publication() AS allowed`;
  // Persist the proposed release before approval so the DB evidence trigger also
  // protects direct review-page activation and retries after this transaction.
  await sql`UPDATE automation.publication_operations SET result=result || ${sql.json({ releaseId: draft.id })} WHERE id=${operationId}::uuid`;
  const active = activate && permission?.allowed === true;
  if (active)
    await transitionTenantConfiguration(
      sql,
      "approve",
      draft.revision,
      "Authorized publication activation",
      `publication:${operationId}:activate`,
    );
  const status = active
    ? "active_for_new_interactions"
    : "published_pending_activation";
  await sql`INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,metadata)
    VALUES(platform.current_tenant_id(),${actor}::uuid,'publication.bundle.created','tenant_configuration',${draft.id}::uuid,${sql.json({ operationId, status, previousReleaseId: state.active.id })})`;
  return {
    status,
    operationId,
    releaseId: draft.id,
    impacts: impacts.map((impact) =>
      impact.status === "unchanged_pinned" ? impact : { ...impact, status },
    ),
  };
}
