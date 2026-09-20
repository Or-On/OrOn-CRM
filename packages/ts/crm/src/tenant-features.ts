import type postgres from "postgres";
import type { JsonValue } from "./types.js";
import { parseServiceWorkflowPolicy } from "./service-workflow.js";

export const tenantFeatureKeys = [
  "contacts",
  "agents",
  "whatsapp",
  "voice",
  "leads",
  "pipeline",
  "tickets",
  "field_service",
  "technicians",
  "documents",
  "ocr",
  "reports",
  "appointments",
  "billing",
] as const;

export type TenantFeatureKey = (typeof tenantFeatureKeys)[number];

export interface TenantFeatureDefinition {
  readonly key: TenantFeatureKey;
  readonly label: string;
  readonly purpose: string;
  readonly dependencies: readonly TenantFeatureKey[];
  readonly configurationSchemaVersion: 1;
}

/** The single catalog shared by settings, navigation, publication and runtime. */
export const tenantFeatureRegistry: Readonly<
  Record<TenantFeatureKey, TenantFeatureDefinition>
> = {
  contacts: {
    key: "contacts",
    label: "Contacts",
    purpose: "Customer identities and history",
    dependencies: [],
    configurationSchemaVersion: 1,
  },
  whatsapp: {
    key: "whatsapp",
    label: "WhatsApp",
    purpose: "Customer messaging",
    dependencies: ["contacts"],
    configurationSchemaVersion: 1,
  },
  voice: {
    key: "voice",
    label: "Voice AI",
    purpose: "Inbound and assigned calls",
    dependencies: ["contacts", "agents"],
    configurationSchemaVersion: 1,
  },
  agents: {
    key: "agents",
    label: "Agents + Flows",
    purpose: "Published conversational behavior",
    dependencies: [],
    configurationSchemaVersion: 1,
  },
  leads: {
    key: "leads",
    label: "Leads",
    purpose: "Commercial interest and qualification",
    dependencies: ["contacts"],
    configurationSchemaVersion: 1,
  },
  pipeline: {
    key: "pipeline",
    label: "Pipeline",
    purpose: "Deals and sales progression",
    dependencies: ["contacts"],
    configurationSchemaVersion: 1,
  },
  tickets: {
    key: "tickets",
    label: "Tickets",
    purpose: "Support issues and escalation",
    dependencies: ["contacts"],
    configurationSchemaVersion: 1,
  },
  field_service: {
    key: "field_service",
    label: "Field service",
    purpose: "Service cases and dispatch",
    dependencies: ["contacts"],
    configurationSchemaVersion: 1,
  },
  technicians: {
    key: "technicians",
    label: "Technicians",
    purpose: "Field workforce and visits",
    dependencies: ["field_service"],
    configurationSchemaVersion: 1,
  },
  ocr: {
    key: "ocr",
    label: "OCR",
    purpose: "Reviewed document and image extraction",
    dependencies: ["documents"],
    configurationSchemaVersion: 1,
  },
  documents: {
    key: "documents",
    label: "Documents",
    purpose: "Tenant-scoped evidence and files",
    dependencies: [],
    configurationSchemaVersion: 1,
  },
  reports: {
    key: "reports",
    label: "Reports",
    purpose: "Operational reporting",
    dependencies: ["contacts"],
    configurationSchemaVersion: 1,
  },
  appointments: {
    key: "appointments",
    label: "Appointments",
    purpose: "Customer and service scheduling",
    dependencies: ["contacts"],
    configurationSchemaVersion: 1,
  },
  billing: {
    key: "billing",
    label: "Billing",
    purpose: "Wallet and payment administration",
    dependencies: [],
    configurationSchemaVersion: 1,
  },
};

export const tenantTemplateRegistry = {
  field_service: {
    version: 2,
    label: "Field Service",
    features: [
      "contacts",
      "whatsapp",
      "voice",
      "agents",
      "tickets",
      "field_service",
      "technicians",
      "ocr",
      "documents",
      "reports",
      "appointments",
    ],
  },
  lead_generation: {
    version: 1,
    label: "Lead Generation",
    features: ["contacts", "whatsapp", "voice", "agents", "leads", "pipeline"],
  },
  customer_support: {
    version: 1,
    label: "Customer Support",
    features: ["contacts", "whatsapp", "voice", "agents", "tickets"],
  },
  leads_support: {
    version: 1,
    label: "Leads + Support",
    features: ["contacts", "agents", "whatsapp", "voice", "leads", "tickets"],
  },
  leads_only: {
    version: 1,
    label: "Leads only",
    features: ["contacts", "leads"],
  },
  blank: { version: 1, label: "Blank / Custom", features: ["contacts"] },
} as const satisfies Record<
  string,
  {
    readonly version: number;
    readonly label: string;
    readonly features: readonly TenantFeatureKey[];
  }
>;

export type TenantTemplateKey = keyof typeof tenantTemplateRegistry;

export async function applyTenantTemplateForAdministrator(
  sql: postgres.TransactionSql,
  tenantId: string,
  key: TenantTemplateKey,
  requestId: string,
): Promise<void> {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(tenantId))
    throw new TypeError("invalid tenant identifier");
  if (!(key in tenantTemplateRegistry))
    throw new TypeError("unknown tenant template");
  await sql`
    SELECT platform.apply_tenant_template_for_administrator(
      ${tenantId}::uuid,${key},${requestId}
    )
  `;
}

export interface TenantFeatureState {
  readonly key: TenantFeatureKey;
  readonly available: boolean;
  readonly enabled: boolean;
  readonly effective: boolean;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly configurationSchemaVersion: number;
  readonly source: "migration" | "template" | "operator" | "provisioning";
  readonly revision: number;
  readonly updatedAt: string | null;
  readonly updatedByUserId: string | null;
}

export type TenantFeatureSnapshot = Readonly<
  Record<TenantFeatureKey, TenantFeatureState>
>;

export class TenantFeatureDisabledError extends Error {
  readonly code = "TENANT_FEATURE_DISABLED";
  readonly feature: TenantFeatureKey;

  constructor(feature: TenantFeatureKey) {
    super(
      `${tenantFeatureRegistry[feature].label} is not enabled for this tenant`,
    );
    this.name = "TenantFeatureDisabledError";
    this.feature = feature;
  }
}

function isFeatureKey(value: unknown): value is TenantFeatureKey {
  return (
    typeof value === "string" &&
    tenantFeatureKeys.includes(value as TenantFeatureKey)
  );
}

export function validateTenantFeatureConfiguration(
  key: TenantFeatureKey,
  value: unknown,
): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("feature configuration must be an object");
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > 16_384)
    throw new TypeError("feature configuration is too large");
  if (key === "field_service" && "workflow" in value) {
    if (Object.keys(value).some((name) => name !== "workflow"))
      throw new TypeError("unknown field service configuration option");
    return { workflow: { ...parseServiceWorkflowPolicy(value.workflow) } };
  }
  if (Object.keys(value).length > 0)
    throw new TypeError(
      "this feature has no configurable fields in schema version 1",
    );
  return value as Readonly<Record<string, JsonValue>>;
}

interface GenericFeatureRow {
  readonly feature_key: string;
  readonly available: boolean;
  readonly enabled: boolean;
  readonly effective: boolean;
  readonly configuration: unknown;
  readonly configuration_schema_version: number;
  readonly source: TenantFeatureState["source"];
  readonly revision: number;
  readonly updated_at: Date | null;
  readonly updated_by_user_id: string | null;
}

export async function getTenantFeatureSnapshot(
  sql: postgres.TransactionSql,
): Promise<TenantFeatureSnapshot> {
  const rows = await sql<GenericFeatureRow[]>`
    SELECT feature.feature_key, feature.available, feature.enabled,
      platform.current_tenant_feature_enabled(feature.feature_key) AS effective,
      feature.configuration, feature.configuration_schema_version,
      feature.source, feature.revision, feature.updated_at,
      feature.updated_by_user_id
    FROM platform.tenant_feature_entitlements feature
    ORDER BY feature.feature_key
  `;
  const found = new Map(rows.map((row) => [row.feature_key, row]));
  return Object.fromEntries(
    tenantFeatureKeys.map((key) => {
      const row = found.get(key);
      return [
        key,
        {
          key,
          available: row?.available === true,
          enabled: row?.enabled === true,
          effective: row?.effective === true,
          configuration:
            row === undefined
              ? {}
              : validateTenantFeatureConfiguration(key, row.configuration),
          configurationSchemaVersion: row?.configuration_schema_version ?? 1,
          source: row?.source ?? "migration",
          revision: row?.revision ?? 0,
          updatedAt: row?.updated_at?.toISOString() ?? null,
          updatedByUserId: row?.updated_by_user_id ?? null,
        },
      ];
    }),
  ) as unknown as TenantFeatureSnapshot;
}

export async function requireTenantFeature(
  sql: postgres.TransactionSql,
  key: TenantFeatureKey,
): Promise<void> {
  const rows = await sql<{ enabled: boolean }[]>`
    SELECT platform.current_tenant_feature_enabled(${key}) AS enabled
  `;
  if (rows[0]?.enabled !== true) throw new TenantFeatureDisabledError(key);
}

export async function setTenantFeature(
  sql: postgres.TransactionSql,
  input: {
    readonly key: TenantFeatureKey;
    readonly enabled: boolean;
    readonly configuration?: Readonly<Record<string, JsonValue>>;
    readonly expectedRevision: number;
    readonly source?: "operator" | "template" | "provisioning";
    readonly requestId: string;
  },
): Promise<TenantFeatureState> {
  if (!isFeatureKey(input.key)) throw new TypeError("unknown tenant feature");
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
    throw new TypeError("expectedRevision must be a positive integer");
  const configuration = validateTenantFeatureConfiguration(
    input.key,
    input.configuration ?? {},
  );
  await sql`
    SELECT platform.set_current_tenant_feature(
      ${input.key}, ${input.enabled}, ${sql.json(configuration)}, 1,
      ${input.expectedRevision}, ${input.source ?? "operator"}, ${input.requestId}
    )
  `;
  return (await getTenantFeatureSnapshot(sql))[input.key];
}

export async function applyTenantTemplate(
  sql: postgres.TransactionSql,
  input: { readonly key: TenantTemplateKey; readonly requestId: string },
): Promise<TenantFeatureSnapshot> {
  const template = tenantTemplateRegistry[input.key];
  const existing = await sql<{ applied: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM platform.tenant_template_applications
      WHERE template_key=${input.key} AND template_version=${template.version}
    ) AS applied
  `;
  if (existing[0]?.applied === true) return getTenantFeatureSnapshot(sql);
  let snapshot = await getTenantFeatureSnapshot(sql);
  const selected = template.features as readonly TenantFeatureKey[];
  const orderedChanges = [
    ...tenantFeatureKeys.filter((key) => selected.includes(key)),
    ...[...tenantFeatureKeys]
      .reverse()
      .filter((key) => !selected.includes(key)),
  ];
  for (const key of orderedChanges) {
    const current = snapshot[key];
    if (current.source === "operator") continue;
    const enabled = selected.includes(key);
    if (current.enabled === enabled) continue;
    await setTenantFeature(sql, {
      key,
      enabled,
      expectedRevision: current.revision,
      source: "template",
      requestId: input.requestId,
    });
    snapshot = await getTenantFeatureSnapshot(sql);
  }
  await sql`
    INSERT INTO platform.tenant_template_applications(
      tenant_id,template_key,template_version,applied_by_user_id,request_id
    ) VALUES(
      platform.current_tenant_id(),${input.key},${template.version},
      platform.current_user_id(),${input.requestId}
    ) ON CONFLICT (tenant_id,template_key,template_version) DO NOTHING
  `;
  return getTenantFeatureSnapshot(sql);
}

export interface FieldServiceFeatureState {
  readonly key: "field_service";
  readonly available: boolean;
  readonly enabled: boolean;
  readonly effective: boolean;
  readonly whatsAppIntakeEnabled: boolean;
  readonly aiSchedulingEnabled: boolean;
  readonly ocrEnabled: boolean;
  readonly sharedTechnicianLoginEnabled: boolean;
  readonly aiScheduleRequiresApproval: boolean;
  readonly calendarAccess: "none" | "read_only" | "write";
  readonly calendarProvider: string | null;
  readonly changedByUserId: string | null;
  readonly changedByDisplayName: string | null;
  readonly changedAt: string | null;
  readonly readiness: {
    readonly manualScheduling: true;
    readonly whatsAppChannel: boolean;
    readonly whatsAppAgent: boolean;
    readonly calendarCanSuggest: boolean;
    readonly calendarCanBook: boolean;
  };
}

interface FeatureRow {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly whatsapp_intake_enabled: boolean;
  readonly ai_scheduling_enabled: boolean;
  readonly ocr_enabled: boolean;
  readonly shared_technician_login_enabled: boolean;
  readonly ai_schedule_requires_approval: boolean;
  readonly calendar_access: FieldServiceFeatureState["calendarAccess"];
  readonly calendar_provider: string | null;
  readonly changed_by_user_id: string | null;
  readonly changed_by_display_name: string | null;
  readonly changed_at: Date | null;
  readonly whatsapp_channel_ready: boolean;
  readonly whatsapp_agent_ready: boolean;
}

export async function getFieldServiceFeatureState(
  sql: postgres.TransactionSql,
): Promise<FieldServiceFeatureState> {
  const rows = await sql<FeatureRow[]>`
    SELECT
      coalesce(entitlement.available, false) AS available,
      coalesce(configuration.enabled, false) AS enabled,
      coalesce(configuration.whatsapp_intake_enabled, false)
        AS whatsapp_intake_enabled,
      coalesce(configuration.ai_scheduling_enabled, false)
        AS ai_scheduling_enabled,
      coalesce(configuration.ocr_enabled, false) AS ocr_enabled,
      coalesce(configuration.shared_technician_login_enabled, false)
        AS shared_technician_login_enabled,
      coalesce(configuration.ai_schedule_requires_approval, true)
        AS ai_schedule_requires_approval,
      coalesce(configuration.calendar_access, 'none') AS calendar_access,
      configuration.calendar_provider,
      configuration.changed_by_user_id,
      platform.current_tenant_member_display_name(
        configuration.changed_by_user_id
      ) AS changed_by_display_name,
      configuration.changed_at,
      EXISTS (
        SELECT 1 FROM messaging.channels channel
        WHERE channel.kind = 'whatsapp' AND channel.status = 'active'
      ) AS whatsapp_channel_ready,
      EXISTS (
        SELECT 1 FROM crm.tenant_settings settings
        JOIN agents.agent_profiles profile
          ON profile.id=settings.whatsapp_ai_agent_profile_id
         AND profile.tenant_id=settings.tenant_id
         AND profile.archived_at IS NULL
        JOIN agents.agent_profile_versions version
          ON version.agent_profile_id=profile.id
         AND version.tenant_id=profile.tenant_id
         AND version.published_at IS NOT NULL
         AND version.validation_status='valid'
         AND version.channel_capabilities @> ARRAY['whatsapp']::text[]
        WHERE settings.tenant_id=current.tenant_id
          AND settings.whatsapp_ai_enabled_by_user_id IS NOT NULL
      ) AS whatsapp_agent_ready
    FROM (SELECT platform.current_tenant_id() AS tenant_id) current
    LEFT JOIN platform.tenant_feature_entitlements entitlement
      ON entitlement.tenant_id = current.tenant_id
     AND entitlement.feature_key = 'field_service'
    LEFT JOIN service.tenant_configuration configuration
      ON configuration.tenant_id = current.tenant_id
  `;
  const row = rows[0];
  const available = row?.available === true;
  const enabled = row?.enabled === true;
  const calendarAccess = row?.calendar_access ?? "none";
  return {
    key: "field_service",
    available,
    enabled,
    effective: available && enabled,
    whatsAppIntakeEnabled: row?.whatsapp_intake_enabled === true,
    aiSchedulingEnabled: row?.ai_scheduling_enabled === true,
    ocrEnabled: row?.ocr_enabled === true,
    sharedTechnicianLoginEnabled: row?.shared_technician_login_enabled === true,
    aiScheduleRequiresApproval: row?.ai_schedule_requires_approval !== false,
    calendarAccess,
    calendarProvider: row?.calendar_provider ?? null,
    changedByUserId: row?.changed_by_user_id ?? null,
    changedByDisplayName: row?.changed_by_display_name ?? null,
    changedAt: row?.changed_at?.toISOString() ?? null,
    readiness: {
      manualScheduling: true,
      whatsAppChannel: row?.whatsapp_channel_ready === true,
      whatsAppAgent: row?.whatsapp_agent_ready === true,
      calendarCanSuggest: calendarAccess !== "none",
      calendarCanBook: calendarAccess === "write",
    },
  };
}

export async function requireFieldService(
  sql: postgres.TransactionSql,
): Promise<FieldServiceFeatureState> {
  const state = await getFieldServiceFeatureState(sql);
  if (!state.effective) throw new TenantFeatureDisabledError("field_service");
  return state;
}

export async function configureFieldService(
  sql: postgres.TransactionSql,
  input: {
    readonly enabled: boolean;
    readonly whatsAppIntakeEnabled: boolean;
    readonly aiSchedulingEnabled: boolean;
    readonly ocrEnabled: boolean;
    readonly sharedTechnicianLoginEnabled: boolean;
    readonly aiScheduleRequiresApproval: boolean;
    readonly calendarAccess: FieldServiceFeatureState["calendarAccess"];
    readonly calendarProvider: "crm_calendar" | null;
    readonly requestId: string;
  },
): Promise<FieldServiceFeatureState> {
  await sql`
    SELECT service.configure_current_tenant(
      ${input.enabled}, ${input.whatsAppIntakeEnabled},
      ${input.aiSchedulingEnabled}, ${input.ocrEnabled},
      ${input.sharedTechnicianLoginEnabled},
      ${input.aiScheduleRequiresApproval}, ${input.calendarAccess},
      ${input.calendarProvider}, ${input.requestId}
    )
  `;
  return getFieldServiceFeatureState(sql);
}

export async function setFieldServiceEntitlement(
  sql: postgres.TransactionSql,
  tenantId: string,
  available: boolean,
  requestId: string,
): Promise<void> {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(tenantId))
    throw new TypeError("Enter a valid tenant identifier");
  await sql`
    SELECT platform.set_tenant_feature_entitlement(
      ${tenantId}::uuid, ${available}, ${requestId}
    )
  `;
}
