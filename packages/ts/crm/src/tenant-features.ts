import type postgres from "postgres";

export const tenantFeatureRegistry = {
  fieldService: {
    key: "field_service",
    label: "Field service",
    defaultAvailable: false,
    defaultEnabled: false,
    optionalDependencies: [
      "whatsapp",
      "ai_scheduling",
      "ocr",
      "shared_technician_login",
    ],
  },
} as const;

export type TenantFeatureKey =
  (typeof tenantFeatureRegistry)[keyof typeof tenantFeatureRegistry]["key"];

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

export class TenantFeatureDisabledError extends Error {
  readonly code = "TENANT_FEATURE_DISABLED";

  constructor() {
    super("Field service is not enabled for this tenant");
    this.name = "TenantFeatureDisabledError";
  }
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
      changed_by.display_name AS changed_by_display_name,
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
    LEFT JOIN public.users changed_by
      ON changed_by.id=configuration.changed_by_user_id
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
  if (!state.effective) throw new TenantFeatureDisabledError();
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
