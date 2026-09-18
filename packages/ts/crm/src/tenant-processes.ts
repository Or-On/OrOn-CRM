import type postgres from "postgres";

import {
  capabilityRequiredFeature,
  parseAgentCapabilities,
} from "./agent-capabilities.js";
import {
  getTenantFeatureSnapshot,
  tenantFeatureKeys,
  type TenantFeatureKey,
} from "./tenant-features.js";

export const tenantProcessTriggers = [
  "whatsapp.new_conversation",
  "whatsapp.message",
  "voice.inbound",
  "voice.outbound_assignment",
  "manual.contact_action",
  "lead.new",
  "service_case.created",
] as const;
export type TenantProcessTrigger = (typeof tenantProcessTriggers)[number];
export type TenantProcessChannel = "whatsapp" | "voice" | "manual";
export type TenantBusinessObject =
  | "contact"
  | "lead"
  | "deal"
  | "ticket"
  | "service_case"
  | "appointment"
  | "document";

export interface TenantProcess {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly enabled: boolean;
  readonly trigger: TenantProcessTrigger;
  readonly channel: TenantProcessChannel | null;
  readonly businessObject: TenantBusinessObject | null;
  readonly agentProfileVersionId: string | null;
  readonly agentName: string | null;
  readonly agentVersion: number | null;
  readonly flowVersionId: string | null;
  readonly flowName: string | null;
  readonly flowVersion: number | null;
  readonly requiredFeatures: readonly TenantFeatureKey[];
  readonly priority: number;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface TenantProcessInput {
  readonly name: string;
  readonly purpose?: string;
  readonly enabled: boolean;
  readonly trigger: TenantProcessTrigger;
  readonly channel?: TenantProcessChannel | null;
  readonly businessObject?: TenantBusinessObject | null;
  readonly agentProfileVersionId?: string | null;
  readonly flowVersionId?: string | null;
  readonly requiredFeatures?: readonly TenantFeatureKey[];
  readonly priority?: number;
}

export interface TenantProcessOptions {
  readonly agents: readonly {
    readonly id: string;
    readonly label: string;
    readonly channels: readonly string[];
  }[];
  readonly flows: readonly {
    readonly id: string;
    readonly label: string;
    readonly channels: readonly string[];
    readonly agentProfileVersionId: string | null;
  }[];
}

export async function listTenantProcessOptions(
  sql: postgres.TransactionSql,
): Promise<TenantProcessOptions> {
  const [agents, flows] = await Promise.all([
    sql<
      {
        id: string;
        name: string;
        version: number;
        channels: readonly string[];
      }[]
    >`
      SELECT version.id,profile.name,version.version,
        version.channel_capabilities AS channels
      FROM agents.agent_profile_versions version
      JOIN agents.agent_profiles profile ON profile.id=version.agent_profile_id
      WHERE version.published_at IS NOT NULL AND version.validation_status='valid'
        AND profile.archived_at IS NULL
      ORDER BY profile.name,version.version DESC
    `,
    sql<
      {
        id: string;
        name: string;
        version: number;
        channels: readonly string[];
        agent_profile_version_id: string | null;
      }[]
    >`
      SELECT version.id,definition.name,version.version,
        definition.channel_capabilities AS channels,
        version.agent_profile_version_id
      FROM automation.flow_versions version
      JOIN automation.flow_definitions definition ON definition.id=version.flow_definition_id
      WHERE version.published_at IS NOT NULL AND version.validation_status='valid'
        AND definition.archived_at IS NULL
      ORDER BY definition.name,version.version DESC
    `,
  ]);
  return {
    agents: agents.map((row) => ({
      id: row.id,
      label: `${row.name} v${String(row.version)}`,
      channels: row.channels,
    })),
    flows: flows.map((row) => ({
      id: row.id,
      label: `${row.name} v${String(row.version)}`,
      channels: row.channels,
      agentProfileVersionId: row.agent_profile_version_id,
    })),
  };
}

interface ProcessRow {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly enabled: boolean;
  readonly trigger_key: TenantProcessTrigger;
  readonly channel: TenantProcessChannel | null;
  readonly business_object_type: TenantBusinessObject | null;
  readonly agent_profile_version_id: string | null;
  readonly agent_name: string | null;
  readonly agent_version: number | null;
  readonly flow_version_id: string | null;
  readonly flow_name: string | null;
  readonly flow_version: number | null;
  readonly required_features: readonly TenantFeatureKey[];
  readonly priority: number;
  readonly revision: number;
  readonly updated_at: Date;
}

function process(row: ProcessRow): TenantProcess {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    enabled: row.enabled,
    trigger: row.trigger_key,
    channel: row.channel,
    businessObject: row.business_object_type,
    agentProfileVersionId: row.agent_profile_version_id,
    agentName: row.agent_name,
    agentVersion: row.agent_version,
    flowVersionId: row.flow_version_id,
    flowName: row.flow_name,
    flowVersion: row.flow_version,
    requiredFeatures: row.required_features,
    priority: row.priority,
    revision: row.revision,
    updatedAt: row.updated_at.toISOString(),
  };
}

const processSelect = `
  SELECT process.id,process.name,process.purpose,process.enabled,
    process.trigger_key,process.channel,process.business_object_type,
    process.agent_profile_version_id,agent_profile.name AS agent_name,
    agent.version AS agent_version,process.flow_version_id,
    flow_definition.name AS flow_name,flow.version AS flow_version,
    process.required_features,process.priority,process.revision,process.updated_at
  FROM automation.tenant_processes process
  LEFT JOIN agents.agent_profile_versions agent ON agent.id=process.agent_profile_version_id
  LEFT JOIN agents.agent_profiles agent_profile ON agent_profile.id=agent.agent_profile_id
  LEFT JOIN automation.flow_versions flow ON flow.id=process.flow_version_id
  LEFT JOIN automation.flow_definitions flow_definition ON flow_definition.id=flow.flow_definition_id
`;

export async function listTenantProcesses(
  sql: postgres.TransactionSql,
): Promise<readonly TenantProcess[]> {
  const rows = await sql.unsafe<ProcessRow[]>(
    `${processSelect} ORDER BY process.enabled DESC,process.priority,process.name,process.id`,
  );
  return rows.map(process);
}

function inferredFeatures(
  input: TenantProcessInput,
): readonly TenantFeatureKey[] {
  const features = new Set(input.requiredFeatures ?? []);
  features.add("contacts");
  if (input.channel === "whatsapp" || input.trigger.startsWith("whatsapp."))
    features.add("whatsapp");
  if (input.channel === "voice" || input.trigger.startsWith("voice."))
    features.add("voice");
  if (
    input.agentProfileVersionId !== null &&
    input.agentProfileVersionId !== undefined
  )
    features.add("agents");
  const objectFeature: Partial<Record<TenantBusinessObject, TenantFeatureKey>> =
    {
      lead: "leads",
      deal: "pipeline",
      ticket: "tickets",
      service_case: "field_service",
      appointment: "appointments",
      document: "documents",
    };
  const required =
    input.businessObject === null || input.businessObject === undefined
      ? undefined
      : objectFeature[input.businessObject];
  if (required !== undefined) features.add(required);
  return [...features].sort();
}

async function validateProcess(
  sql: postgres.TransactionSql,
  input: TenantProcessInput,
): Promise<readonly TenantFeatureKey[]> {
  if (!tenantProcessTriggers.includes(input.trigger))
    throw new TypeError("unsupported process trigger");
  if (input.name.trim().length === 0 || input.name.trim().length > 120)
    throw new TypeError(
      "process name is required and must be 120 characters or fewer",
    );
  if ((input.purpose?.length ?? 0) > 1000)
    throw new TypeError("process purpose must be 1000 characters or fewer");
  const priority = input.priority ?? 100;
  if (!Number.isInteger(priority) || priority < 0 || priority > 10000)
    throw new TypeError("process priority must be 0 to 10000");
  for (const feature of input.requiredFeatures ?? [])
    if (!tenantFeatureKeys.includes(feature))
      throw new TypeError(`unknown required feature: ${feature}`);
  const required = inferredFeatures(input);
  if (!input.enabled) return required;
  if (
    input.agentProfileVersionId === null ||
    input.agentProfileVersionId === undefined ||
    input.flowVersionId === null ||
    input.flowVersionId === undefined
  )
    throw new TypeError(
      "an active process requires exact published agent and flow versions",
    );
  const snapshot = await getTenantFeatureSnapshot(sql);
  const disabled = required.filter((key) => !snapshot[key].effective);
  if (disabled.length > 0)
    throw new TypeError(
      `process requires disabled modules: ${disabled.join(", ")}`,
    );
  const bindings = await sql<
    {
      agent_channels: readonly string[];
      tool_permissions: unknown;
      flow_channels: readonly string[];
      flow_agent_version_id: string | null;
    }[]
  >`
    SELECT agent.channel_capabilities AS agent_channels,
      agent.tool_permissions,definition.channel_capabilities AS flow_channels,
      flow.agent_profile_version_id AS flow_agent_version_id
    FROM agents.agent_profile_versions agent
    JOIN automation.flow_versions flow ON flow.id=${input.flowVersionId}::uuid
      AND flow.published_at IS NOT NULL AND flow.validation_status='valid'
    JOIN automation.flow_definitions definition ON definition.id=flow.flow_definition_id
    WHERE agent.id=${input.agentProfileVersionId}::uuid
      AND agent.published_at IS NOT NULL AND agent.validation_status='valid'
  `;
  const binding = bindings[0];
  if (binding === undefined)
    throw new TypeError(
      "selected agent and flow must be published and valid in this tenant",
    );
  if (
    binding.flow_agent_version_id !== null &&
    binding.flow_agent_version_id !== input.agentProfileVersionId
  )
    throw new TypeError(
      "the selected flow is pinned to a different agent version",
    );
  if (
    input.channel !== null &&
    input.channel !== undefined &&
    input.channel !== "manual"
  ) {
    if (
      !binding.agent_channels.includes(input.channel) ||
      !binding.flow_channels.includes(input.channel)
    )
      throw new TypeError(
        `selected agent and flow do not support ${input.channel}`,
      );
  }
  const capabilityFeatures = parseAgentCapabilities(
    binding.tool_permissions,
  ).map(capabilityRequiredFeature);
  const incompatible = capabilityFeatures.filter(
    (key) => !snapshot[key].effective,
  );
  if (incompatible.length > 0)
    throw new TypeError(
      `agent uses disabled modules: ${[...new Set(incompatible)].join(", ")}`,
    );
  return [...new Set([...required, ...capabilityFeatures])].sort();
}

export async function createTenantProcess(
  sql: postgres.TransactionSql,
  actorUserId: string,
  input: TenantProcessInput,
  requestId: string,
): Promise<TenantProcess> {
  const required = await validateProcess(sql, input);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO automation.tenant_processes(
      tenant_id,name,purpose,enabled,trigger_key,channel,business_object_type,
      agent_profile_version_id,flow_version_id,required_features,priority,
      created_by_user_id,updated_by_user_id
    ) VALUES(
      platform.current_tenant_id(),${input.name.trim()},${input.purpose?.trim() ?? ""},
      ${input.enabled},${input.trigger},${input.channel ?? null},${input.businessObject ?? null},
      ${input.agentProfileVersionId ?? null}::uuid,${input.flowVersionId ?? null}::uuid,
      ${required},${input.priority ?? 100},${actorUserId}::uuid,${actorUserId}::uuid
    ) RETURNING id
  `;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("process insert failed");
  await sql`
    INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,request_id,metadata)
    VALUES(platform.current_tenant_id(),${actorUserId}::uuid,'tenant.process.created','tenant_process',${id}::uuid,
      ${requestId},${sql.json({ trigger: input.trigger, enabled: input.enabled, requiredFeatures: required })})
  `;
  const created = await sql.unsafe<ProcessRow[]>(
    `${processSelect} WHERE process.id=$1::uuid`,
    [id],
  );
  if (created[0] === undefined) throw new Error("process readback failed");
  return process(created[0]);
}

export async function updateTenantProcess(
  sql: postgres.TransactionSql,
  actorUserId: string,
  id: string,
  expectedRevision: number,
  input: TenantProcessInput,
  requestId: string,
): Promise<TenantProcess> {
  const required = await validateProcess(sql, input);
  const rows = await sql<{ revision: number }[]>`
    UPDATE automation.tenant_processes SET
      name=${input.name.trim()},purpose=${input.purpose?.trim() ?? ""},enabled=${input.enabled},
      trigger_key=${input.trigger},channel=${input.channel ?? null},business_object_type=${input.businessObject ?? null},
      agent_profile_version_id=${input.agentProfileVersionId ?? null}::uuid,
      flow_version_id=${input.flowVersionId ?? null}::uuid,required_features=${required},
      priority=${input.priority ?? 100},revision=revision+1,updated_by_user_id=${actorUserId}::uuid,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=${id}::uuid AND revision=${expectedRevision}
    RETURNING revision
  `;
  if (rows[0] === undefined)
    throw new TypeError("process changed; refresh before saving");
  await sql`
    INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,request_id,metadata)
    VALUES(platform.current_tenant_id(),${actorUserId}::uuid,'tenant.process.updated','tenant_process',${id}::uuid,
      ${requestId},${sql.json({ revision: rows[0].revision, enabled: input.enabled, requiredFeatures: required })})
  `;
  const updated = await sql.unsafe<ProcessRow[]>(
    `${processSelect} WHERE process.id=$1::uuid`,
    [id],
  );
  if (updated[0] === undefined) throw new Error("process readback failed");
  return process(updated[0]);
}

/** Deterministic runtime routing: explicit priority, then reject ambiguity. */
export async function resolveTenantProcess(
  sql: postgres.TransactionSql,
  trigger: TenantProcessTrigger,
  channel: TenantProcessChannel | null,
): Promise<TenantProcess | null> {
  const rows = await sql.unsafe<ProcessRow[]>(
    `${processSelect} WHERE process.enabled AND process.trigger_key=$1
      AND (process.channel=$2 OR process.channel IS NULL)
      ORDER BY process.priority,process.id LIMIT 2`,
    [trigger, channel],
  );
  if (rows.length > 1 && rows[0]?.priority === rows[1]?.priority)
    throw new TypeError("ambiguous active process bindings");
  return rows[0] === undefined ? null : process(rows[0]);
}
