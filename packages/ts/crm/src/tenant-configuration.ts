import type postgres from "postgres";

import {
  capabilityRequiredFeature,
  parseAgentCapabilities,
} from "./agent-capabilities.js";
import {
  getTenantFeatureSnapshot,
  tenantFeatureKeys,
  tenantFeatureRegistry,
  tenantTemplateRegistry,
  validateTenantFeatureConfiguration,
  type TenantFeatureKey,
} from "./tenant-features.js";
import {
  listTenantProcesses,
  tenantProcessTriggers,
  type TenantProcessInput,
} from "./tenant-processes.js";
import type { JsonValue } from "./types.js";
import { parseServiceWorkflowPolicy } from "./service-workflow.js";
import { parseLeadFieldSchema } from "./lead-schema.js";
export { configurationFromTemplate } from "./tenant-configuration-client.js";

/** A reviewed package is data, never executable tenant-supplied code. */
export interface TenantConfiguration {
  readonly schemaVersion: 1;
  readonly templateKey: string | null;
  readonly features: readonly TenantFeatureKey[];
  readonly featureConfiguration: Readonly<
    Partial<Record<TenantFeatureKey, Readonly<Record<string, JsonValue>>>>
  >;
  readonly processes: readonly TenantProcessInput[];
}

export interface TenantConfigurationRelease {
  readonly id: string;
  readonly version: number;
  readonly revision: number;
  readonly status: "draft" | "submitted" | "published" | "rejected";
  readonly configuration: TenantConfiguration;
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly approvedAt: string | null;
  readonly approvedByUserId: string | null;
  readonly reviewNotes: string | null;
}

export interface TenantConfigurationState {
  readonly active: TenantConfigurationRelease | null;
  readonly draft: TenantConfigurationRelease | null;
  readonly history: readonly TenantConfigurationRelease[];
  readonly canApprove: boolean;
  readonly initialConfiguration: TenantConfiguration;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  )
    throw new TypeError(
      `${label} must contain 1 to ${String(maximum)} characters`,
    );
  return value.trim();
}

function uuidOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(value)
  )
    throw new TypeError("Agent and flow versions must be valid identifiers");
  return value;
}

export function parseTenantConfiguration(value: unknown): TenantConfiguration {
  const input = object(value, "Configuration");
  if (input.schemaVersion !== 1)
    throw new TypeError("Unsupported configuration version");
  if (new TextEncoder().encode(JSON.stringify(input)).length > 131072)
    throw new TypeError("Configuration is too large");
  if (
    !Array.isArray(input.features) ||
    input.features.length > tenantFeatureKeys.length
  )
    throw new TypeError("Choose a valid set of modules");
  const features = [...new Set(input.features)] as TenantFeatureKey[];
  if (features.some((key) => !tenantFeatureKeys.includes(key)))
    throw new TypeError("Unknown module");
  if (!features.includes("contacts"))
    throw new TypeError("Contacts is required for every workspace");
  for (const key of features)
    for (const dependency of tenantFeatureRegistry[key].dependencies)
      if (!features.includes(dependency))
        throw new TypeError(
          `${tenantFeatureRegistry[key].label} requires ${tenantFeatureRegistry[dependency].label}`,
        );
  const configuration = object(
    input.featureConfiguration ?? {},
    "Module configuration",
  );
  const featureConfiguration: Partial<
    Record<TenantFeatureKey, Readonly<Record<string, JsonValue>>>
  > = {};
  for (const [key, settings] of Object.entries(configuration)) {
    if (!tenantFeatureKeys.includes(key as TenantFeatureKey))
      throw new TypeError("Unknown module configuration");
    featureConfiguration[key as TenantFeatureKey] =
      validateTenantFeatureConfiguration(key as TenantFeatureKey, settings);
  }
  if (!Array.isArray(input.processes) || input.processes.length > 50)
    throw new TypeError("A workspace can configure up to 50 processes");
  const processes = input.processes.map((value): TenantProcessInput => {
    const process = object(value, "Process");
    if (
      !tenantProcessTriggers.includes(process.trigger as never) ||
      typeof process.enabled !== "boolean"
    )
      throw new TypeError(
        "Choose a supported process trigger and enabled state",
      );
    const channel = process.channel ?? null;
    if (
      channel !== null &&
      (typeof channel !== "string" ||
        !["whatsapp", "voice", "manual"].includes(channel))
    )
      throw new TypeError("Choose a supported process channel");
    const businessObject = process.businessObject ?? null;
    if (
      businessObject !== null &&
      (typeof businessObject !== "string" ||
        ![
          "contact",
          "lead",
          "deal",
          "ticket",
          "service_case",
          "appointment",
          "document",
        ].includes(businessObject))
    )
      throw new TypeError("Choose a supported business object");
    const priority = process.priority ?? 100;
    if (
      typeof priority !== "number" ||
      !Number.isInteger(priority) ||
      priority < 0 ||
      priority > 10000
    )
      throw new TypeError("Process priority must be between 0 and 10000");
    const required = process.requiredFeatures ?? [];
    if (
      !Array.isArray(required) ||
      required.some(
        (key) => !tenantFeatureKeys.includes(key as TenantFeatureKey),
      )
    )
      throw new TypeError("Unknown process module requirement");
    const purpose =
      process.purpose === undefined || process.purpose === ""
        ? ""
        : text(process.purpose, "Process purpose", 1000);
    return {
      name: text(process.name, "Process name", 120),
      purpose,
      enabled: process.enabled,
      trigger: process.trigger as TenantProcessInput["trigger"],
      channel: channel as Exclude<TenantProcessInput["channel"], undefined>,
      businessObject: businessObject as Exclude<
        TenantProcessInput["businessObject"],
        undefined
      >,
      agentProfileVersionId: uuidOrNull(process.agentProfileVersionId),
      flowVersionId: uuidOrNull(process.flowVersionId),
      requiredFeatures: [...new Set(required)] as TenantFeatureKey[],
      priority,
    };
  });
  const templateKey = input.templateKey ?? null;
  if (
    templateKey !== null &&
    (typeof templateKey !== "string" ||
      !Object.hasOwn(tenantTemplateRegistry, templateKey))
  )
    throw new TypeError("Unknown workspace template");
  return {
    schemaVersion: 1,
    templateKey,
    features,
    featureConfiguration,
    processes,
  };
}

/** Validate against the proposed modules; approval need not enable them first. */
export async function validateTenantConfiguration(
  sql: postgres.TransactionSql,
  configuration: TenantConfiguration,
): Promise<void> {
  const active = configuration.processes.filter((process) => process.enabled);
  const objectFeatures: Record<string, TenantFeatureKey> = {
    lead: "leads",
    deal: "pipeline",
    ticket: "tickets",
    service_case: "field_service",
    appointment: "appointments",
    document: "documents",
    contact: "contacts",
  };
  for (let index = 0; index < active.length; index++) {
    const process = active[index];
    if (process === undefined) continue;
    if (!process.agentProfileVersionId || !process.flowVersionId)
      throw new TypeError(
        `${process.name}: select published agent and flow versions`,
      );
    const channel = process.trigger.startsWith("whatsapp.")
      ? "whatsapp"
      : process.trigger.startsWith("voice.")
        ? "voice"
        : process.channel;
    if (channel && process.channel && channel !== process.channel)
      throw new TypeError(
        `${process.name}: channel does not match its trigger`,
      );
    for (const other of active.slice(index + 1))
      if (
        other.trigger === process.trigger &&
        (other.priority ?? 100) === (process.priority ?? 100) &&
        (other.channel === process.channel ||
          !other.channel ||
          !process.channel)
      )
        throw new TypeError(
          `${process.name}: another active process has the same routing priority`,
        );
    const rows = await sql<
      {
        channels: readonly string[];
        flow_channels: readonly string[];
        tool_permissions: unknown;
        flow_agent: string | null;
        lead_schema_definition: unknown;
      }[]
    >`
      SELECT agent.channel_capabilities AS channels,definition.channel_capabilities AS flow_channels,
        agent.tool_permissions,flow.agent_profile_version_id AS flow_agent,
        lead_schema.definition AS lead_schema_definition
      FROM agents.agent_profile_versions agent
      JOIN agents.agent_profiles profile ON profile.id=agent.agent_profile_id
      JOIN automation.flow_versions flow ON flow.id=${process.flowVersionId}::uuid
        AND flow.tenant_id=agent.tenant_id
      JOIN automation.flow_definitions definition ON definition.id=flow.flow_definition_id
      LEFT JOIN crm.lead_field_schemas lead_schema
        ON lead_schema.tenant_id=agent.tenant_id
        AND lead_schema.id::text=lower(agent.channel_configuration->>'leadFieldSchemaId')
        AND lead_schema.published_at IS NOT NULL
      WHERE agent.id=${process.agentProfileVersionId}::uuid
        AND agent.tenant_id=platform.current_tenant_id()
        AND agent.published_at IS NOT NULL AND agent.validation_status='valid'
        AND flow.published_at IS NOT NULL AND flow.validation_status='valid'
        AND profile.archived_at IS NULL AND definition.archived_at IS NULL
    `;
    const binding = rows[0];
    if (
      !binding ||
      (binding.flow_agent !== null &&
        binding.flow_agent !== process.agentProfileVersionId)
    )
      throw new TypeError(
        `${process.name}: agent and flow must be compatible published versions in this workspace`,
      );
    if (
      channel &&
      channel !== "manual" &&
      (!binding.channels.includes(channel) ||
        !binding.flow_channels.includes(channel))
    )
      throw new TypeError(
        `${process.name}: selected versions do not support ${channel}`,
      );
    const capabilities = parseAgentCapabilities(binding.tool_permissions);
    // A process's business-object label is a promise of an executable workflow,
    // not just a request to show that module in the sidebar. Read/finalize-only
    // agents cannot create a lead, and an unpinned schema cannot collect fields.
    if (process.businessObject === "lead") {
      if (!capabilities.includes("lead.write"))
        throw new TypeError(
          `${process.name}: lead workflows require an agent with lead.write`,
        );
      if (binding.lead_schema_definition == null)
        throw new TypeError(
          `${process.name}: lead workflows require a pinned published lead field schema in this workspace`,
        );
      parseLeadFieldSchema(binding.lead_schema_definition);
    }
    const required = new Set<TenantFeatureKey>([
      "contacts",
      "agents",
      ...(process.requiredFeatures ?? []),
      ...capabilities.map(capabilityRequiredFeature),
    ]);
    if (capabilities.includes("service.intake")) {
      required.add("tickets");
      if (
        channel === "voice" &&
        parseServiceWorkflowPolicy(
          configuration.featureConfiguration.field_service?.workflow,
        ).requiredIntakeFields.includes("nationalId")
      )
        throw new TypeError(
          `${process.name}: voice service intake cannot collect government identification; select a workflow without nationalId`,
        );
    }
    if (channel === "whatsapp" || channel === "voice") required.add(channel);
    const objectFeature = process.businessObject
      ? objectFeatures[process.businessObject]
      : undefined;
    if (objectFeature) required.add(objectFeature);
    for (const feature of required)
      if (!configuration.features.includes(feature))
        throw new TypeError(
          `${process.name}: enable ${tenantFeatureRegistry[feature].label} in this configuration`,
        );
  }
}

interface ReleaseRow {
  id: string;
  version: number;
  revision: number;
  status: TenantConfigurationRelease["status"];
  configuration: TenantConfiguration;
  created_at: Date;
  submitted_at: Date | null;
  approved_at: Date | null;
  approved_by_user_id: string | null;
  review_notes: string | null;
}
function release(row: ReleaseRow): TenantConfigurationRelease {
  return {
    id: row.id,
    version: row.version,
    revision: row.revision,
    status: row.status,
    configuration: row.configuration,
    createdAt: row.created_at.toISOString(),
    submittedAt: row.submitted_at?.toISOString() ?? null,
    approvedAt: row.approved_at?.toISOString() ?? null,
    approvedByUserId: row.approved_by_user_id,
    reviewNotes: row.review_notes,
  };
}

export async function getTenantConfigurationState(
  sql: postgres.TransactionSql,
  canApprove = false,
): Promise<TenantConfigurationState> {
  const rows = await sql<ReleaseRow[]>`
    SELECT id,version,revision,status,configuration,created_at,submitted_at,approved_at,approved_by_user_id,review_notes
    FROM platform.tenant_configuration_releases
    WHERE id IN (SELECT id FROM platform.tenant_configuration_releases ORDER BY version DESC LIMIT 50)
       OR id = (SELECT id FROM platform.tenant_configuration_releases WHERE status='published' ORDER BY version DESC LIMIT 1)
    ORDER BY version DESC
  `;
  const history = rows.map(release);
  const active = history.find((entry) => entry.status === "published") ?? null;
  const draft =
    history.find(
      (entry) => entry.status === "draft" || entry.status === "submitted",
    ) ?? null;
  if (active)
    return {
      active,
      draft,
      history,
      canApprove,
      initialConfiguration: active.configuration,
    };
  const [features, processes] = await Promise.all([
    getTenantFeatureSnapshot(sql),
    listTenantProcesses(sql),
  ]);
  return {
    active,
    draft,
    history,
    canApprove,
    initialConfiguration: {
      schemaVersion: 1,
      templateKey: null,
      features: tenantFeatureKeys.filter((key) => features[key].effective),
      featureConfiguration: Object.fromEntries(
        tenantFeatureKeys.map((key) => [key, features[key].configuration]),
      ),
      processes: processes.map((process) => ({
        name: process.name,
        purpose: process.purpose,
        enabled: process.enabled,
        trigger: process.trigger,
        channel: process.channel,
        businessObject: process.businessObject,
        agentProfileVersionId: process.agentProfileVersionId,
        flowVersionId: process.flowVersionId,
        requiredFeatures: process.requiredFeatures,
        priority: process.priority,
      })),
    },
  };
}

export async function saveTenantConfigurationDraft(
  sql: postgres.TransactionSql,
  value: unknown,
  expectedRevision: number | null,
  requestId: string,
): Promise<void> {
  const configuration = parseTenantConfiguration(value);
  if (
    expectedRevision !== null &&
    (!Number.isInteger(expectedRevision) || expectedRevision < 1)
  )
    throw new TypeError("A valid draft revision is required");
  await sql`SELECT platform.save_tenant_configuration_draft(${sql.json(configuration as unknown as JsonValue)},${expectedRevision},${requestId})`;
}

export async function transitionTenantConfiguration(
  sql: postgres.TransactionSql,
  action: "submit" | "approve" | "reject",
  expectedRevision: number,
  note: string,
  requestId: string,
): Promise<void> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    throw new TypeError("A valid draft revision is required");
  if (note.length > 2000)
    throw new TypeError("Review notes must be 2000 characters or fewer");
  const state = await getTenantConfigurationState(sql);
  if (!state.draft)
    throw new TypeError("There is no configuration awaiting review");
  if (action !== "reject")
    await validateTenantConfiguration(
      sql,
      parseTenantConfiguration(state.draft.configuration),
    );
  await sql`SELECT platform.review_tenant_configuration(${action},${expectedRevision},${note},${requestId})`;
}

export async function initializeTenantConfiguration(
  sql: postgres.TransactionSql,
  tenantId: string,
  configuration: TenantConfiguration,
  requestId: string,
): Promise<void> {
  const parsed = parseTenantConfiguration(configuration);
  await sql`SELECT platform.initialize_tenant_configuration(${tenantId}::uuid,${sql.json(parsed as unknown as JsonValue)},${requestId})`;
}
