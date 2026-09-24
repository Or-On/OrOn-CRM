import type postgres from "postgres";
import type { IntakeRequiredField } from "./field-service-domain.js";

export const serviceIntakeFieldKeys = [
  "customerName",
  "customerPhone",
  "nationalId",
  "chainName",
  "storeName",
  "serviceLocation",
  "faultDescription",
  "exactFailure",
  "warrantyStatus",
  "callbackNumber",
  "urgency",
] as const;
export const serviceReportFieldKeys = [
  "diagnosis",
  "workPerformed",
  "partReplaced",
  "arrivalSignature",
  "departureSignature",
  "faultPhoto",
  "modulePhoto",
] as const;
export type ServiceReportField = (typeof serviceReportFieldKeys)[number];
export const followUpTemplateParameterKeys = [
  "customerName",
  "reference",
  "faultSummary",
  "businessName",
] as const;
export type FollowUpTemplateParameter =
  (typeof followUpTemplateParameterKeys)[number];

/* eslint-disable @typescript-eslint/consistent-type-definitions --
   Nested policy sections stay type aliases: interfaces are not assignable to
   JsonValue, which tenant configuration packages require. */
/** Phone intake opens a visible inquiry at call admission. */
export type InquiryPolicy = {
  readonly openOnFirstContact: boolean;
};
/** The server-rendered WhatsApp summary and photo request after a call. */
export type WhatsAppFollowUpPolicy = {
  readonly enabled: boolean;
  readonly trigger: "intake_saved" | "call_ended";
  readonly requestPhoto: boolean;
  readonly consent: "in_call_agreement" | "existing_only";
  readonly templateName?: string;
  readonly templateLanguage?: string;
  readonly templateParameters?: readonly FollowUpTemplateParameter[];
};
export type EmergencyPolicy = {
  readonly enabled: boolean;
  /** Tenant wording for the label, e.g. a business's own name for a red call. */
  readonly label: string;
  readonly manualRedCall: boolean;
  /** Administrator-only routing contact; redacted from every other reader. */
  readonly transferTo?: string;
  readonly fallback: "urgent_followup" | "notify_staff";
};
export type PreparationChecklistItem = {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
};
export type PreparationPolicy = {
  readonly enabled: boolean;
  readonly instructions?: string;
  readonly requireAcknowledgement: boolean;
  readonly checklist: readonly PreparationChecklistItem[];
};
export type AttachmentCategoryPolicy = {
  readonly key: string;
  readonly label: string;
  readonly accept: readonly ("image" | "pdf")[];
};
export type EvidencePolicy = {
  readonly beforePhotoRequired: boolean;
  readonly afterPhotoRequired: boolean;
};
/* eslint-enable @typescript-eslint/consistent-type-definitions */
export interface ServiceWorkflowPolicy {
  readonly version: 1;
  readonly requiredIntakeFields: readonly IntakeRequiredField[];
  readonly photoPolicy: "optional" | "requested" | "required";
  readonly selfAssignmentEnabled: boolean;
  readonly requiredReportFields: readonly ServiceReportField[];
  readonly inquiry?: InquiryPolicy;
  readonly whatsappFollowUp?: WhatsAppFollowUpPolicy;
  readonly emergency?: EmergencyPolicy;
  readonly preparation?: PreparationPolicy;
  readonly attachmentCategories?: readonly AttachmentCategoryPolicy[];
  readonly evidence?: EvidencePolicy;
}

const builtInAttachmentCategories = new Set([
  "fault",
  "module",
  "product_label",
  "repair",
  "environment",
  "document",
  "customer_photo",
  "arrival_signature",
  "departure_signature",
  "before_photo",
  "after_photo",
  "tenant_document",
]);
export const serviceWorkflowDefaults: ServiceWorkflowPolicy = {
  version: 1,
  requiredIntakeFields: [
    "customerName",
    "customerPhone",
    "nationalId",
    "storeName",
    "serviceLocation",
    "faultDescription",
    "warrantyStatus",
  ],
  photoPolicy: "optional",
  selfAssignmentEnabled: false,
  requiredReportFields: [...serviceReportFieldKeys],
};
export const retailServiceWorkflowPolicy: ServiceWorkflowPolicy = {
  version: 1,
  requiredIntakeFields: [
    "customerName",
    "customerPhone",
    "chainName",
    "storeName",
    "faultDescription",
    "exactFailure",
  ],
  photoPolicy: "requested",
  selfAssignmentEnabled: true,
  requiredReportFields: [
    "diagnosis",
    "workPerformed",
    "partReplaced",
    "faultPhoto",
  ],
};

/** Configuration is executable policy, so reject unknown or malformed options. */
export function parseServiceWorkflowPolicy(
  value: unknown,
): ServiceWorkflowPolicy {
  if (value === undefined || value === null) return serviceWorkflowDefaults;
  if (typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Service workflow must be an object");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "version",
          "requiredIntakeFields",
          "photoPolicy",
          "selfAssignmentEnabled",
          "requiredReportFields",
          "inquiry",
          "whatsappFollowUp",
          "emergency",
          "preparation",
          "attachmentCategories",
          "evidence",
        ].includes(key),
    )
  )
    throw new TypeError("Unknown service workflow setting");
  if (
    input.version !== 1 ||
    typeof input.selfAssignmentEnabled !== "boolean" ||
    !["optional", "requested", "required"].includes(String(input.photoPolicy))
  )
    throw new TypeError("Invalid service workflow settings");
  function keys<T extends string>(
    candidate: unknown,
    allowed: readonly T[],
  ): readonly T[] {
    if (
      !Array.isArray(candidate) ||
      candidate.some(
        (key) => typeof key !== "string" || !allowed.includes(key as T),
      ) ||
      new Set(candidate).size !== candidate.length
    )
      throw new TypeError("Invalid service workflow required fields");
    return candidate as T[];
  }
  const intake = keys(input.requiredIntakeFields, serviceIntakeFieldKeys);
  if (!intake.includes("faultDescription"))
    throw new TypeError("A service workflow requires a fault description");
  return {
    version: 1,
    requiredIntakeFields: intake,
    photoPolicy: input.photoPolicy as ServiceWorkflowPolicy["photoPolicy"],
    selfAssignmentEnabled: input.selfAssignmentEnabled,
    requiredReportFields: keys(
      input.requiredReportFields,
      serviceReportFieldKeys,
    ),
    ...optionalPolicies(input),
  };
}

function object(
  value: unknown,
  allowed: readonly string[],
  name: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new TypeError(`Unknown ${name} setting`);
  return value as Record<string, unknown>;
}

function flag(value: unknown, name: string): boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`${name} must be true or false`);
  return value;
}

function label(value: unknown, maximum: number, name: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim().length > maximum
  )
    throw new TypeError(`${name} must contain 1-${String(maximum)} characters`);
  return value;
}

/** Optional capabilities; absent keys keep the tenant's existing behaviour. */
function optionalPolicies(
  input: Record<string, unknown>,
): Partial<ServiceWorkflowPolicy> {
  const result: {
    inquiry?: InquiryPolicy;
    whatsappFollowUp?: WhatsAppFollowUpPolicy;
    emergency?: EmergencyPolicy;
    preparation?: PreparationPolicy;
    attachmentCategories?: readonly AttachmentCategoryPolicy[];
    evidence?: EvidencePolicy;
  } = {};
  if (input.inquiry !== undefined) {
    const inquiry = object(input.inquiry, ["openOnFirstContact"], "inquiry");
    result.inquiry = {
      openOnFirstContact: flag(
        inquiry.openOnFirstContact,
        "Open on first contact",
      ),
    };
  }
  if (input.whatsappFollowUp !== undefined) {
    const value = object(
      input.whatsappFollowUp,
      [
        "enabled",
        "trigger",
        "requestPhoto",
        "consent",
        "templateName",
        "templateLanguage",
        "templateParameters",
      ],
      "WhatsApp follow-up",
    );
    if (value.trigger !== "intake_saved" && value.trigger !== "call_ended")
      throw new TypeError("Choose when the WhatsApp follow-up is sent");
    if (
      value.consent !== "in_call_agreement" &&
      value.consent !== "existing_only"
    )
      throw new TypeError("Choose how WhatsApp consent is obtained");
    if (
      (value.templateName === undefined) !==
      (value.templateLanguage === undefined)
    )
      throw new TypeError(
        "An approved template needs both a name and a language",
      );
    if (
      value.templateName !== undefined &&
      (typeof value.templateName !== "string" ||
        !/^[a-z0-9_]{1,512}$/u.test(value.templateName) ||
        typeof value.templateLanguage !== "string" ||
        !/^[a-z]{2,3}(?:_[A-Z]{2})?$/u.test(value.templateLanguage))
    )
      throw new TypeError("Invalid approved WhatsApp template");
    let parameters: readonly FollowUpTemplateParameter[] | undefined;
    if (value.templateParameters !== undefined) {
      if (
        value.templateName === undefined ||
        !Array.isArray(value.templateParameters) ||
        value.templateParameters.length > 5 ||
        value.templateParameters.some(
          (item) =>
            typeof item !== "string" ||
            !(followUpTemplateParameterKeys as readonly string[]).includes(
              item,
            ),
        )
      )
        throw new TypeError("Invalid template parameters");
      parameters = value.templateParameters as FollowUpTemplateParameter[];
    }
    result.whatsappFollowUp = {
      enabled: flag(value.enabled, "WhatsApp follow-up"),
      trigger: value.trigger,
      requestPhoto: flag(value.requestPhoto, "Photo request"),
      consent: value.consent,
      ...(typeof value.templateName === "string" &&
      typeof value.templateLanguage === "string"
        ? {
            templateName: value.templateName,
            templateLanguage: value.templateLanguage,
          }
        : {}),
      ...(parameters === undefined ? {} : { templateParameters: parameters }),
    };
  }
  if (input.emergency !== undefined) {
    const value = object(
      input.emergency,
      ["enabled", "label", "manualRedCall", "transferTo", "fallback"],
      "emergency",
    );
    if (
      value.fallback !== "urgent_followup" &&
      value.fallback !== "notify_staff"
    )
      throw new TypeError("Choose the emergency fallback");
    if (
      value.transferTo !== undefined &&
      (typeof value.transferTo !== "string" ||
        !/^\+[1-9][0-9]{7,14}$/u.test(value.transferTo))
    )
      throw new TypeError(
        "The on-call number must be in international E.164 format",
      );
    result.emergency = {
      enabled: flag(value.enabled, "Emergency handling"),
      label: label(value.label, 40, "Emergency label"),
      manualRedCall: flag(value.manualRedCall, "Manual emergency calls"),
      ...(typeof value.transferTo === "string"
        ? { transferTo: value.transferTo }
        : {}),
      fallback: value.fallback,
    };
  }
  if (input.preparation !== undefined) {
    const value = object(
      input.preparation,
      ["enabled", "instructions", "requireAcknowledgement", "checklist"],
      "preparation",
    );
    if (!Array.isArray(value.checklist) || value.checklist.length > 30)
      throw new TypeError("The preparation checklist can hold up to 30 items");
    const checklist = value.checklist.map((item) => {
      const entry = object(
        item,
        ["key", "label", "required"],
        "checklist item",
      );
      if (
        typeof entry.key !== "string" ||
        !/^[a-z0-9_]{1,40}$/u.test(entry.key)
      )
        throw new TypeError(
          "Checklist keys use lowercase letters, digits and underscores",
        );
      return {
        key: entry.key,
        label: label(entry.label, 160, "Checklist label"),
        required: flag(entry.required, "Required checklist item"),
      };
    });
    if (new Set(checklist.map((item) => item.key)).size !== checklist.length)
      throw new TypeError("Checklist keys must be unique");
    if (
      value.instructions !== undefined &&
      (typeof value.instructions !== "string" ||
        value.instructions.length > 2000)
    )
      throw new TypeError(
        "Preparation instructions can hold up to 2000 characters",
      );
    result.preparation = {
      enabled: flag(value.enabled, "Preparation"),
      ...(typeof value.instructions === "string"
        ? { instructions: value.instructions }
        : {}),
      requireAcknowledgement: flag(
        value.requireAcknowledgement,
        "Preparation acknowledgement",
      ),
      checklist,
    };
  }
  if (input.attachmentCategories !== undefined) {
    if (
      !Array.isArray(input.attachmentCategories) ||
      input.attachmentCategories.length > 12
    )
      throw new TypeError("Up to 12 document types can be configured");
    const categories = input.attachmentCategories.map((item) => {
      const entry = object(item, ["key", "label", "accept"], "document type");
      if (
        typeof entry.key !== "string" ||
        !/^[a-z][a-z0-9_]{1,31}$/u.test(entry.key) ||
        builtInAttachmentCategories.has(entry.key)
      )
        throw new TypeError("Invalid document type key");
      if (
        !Array.isArray(entry.accept) ||
        entry.accept.length < 1 ||
        entry.accept.length > 2 ||
        entry.accept.some((kind) => kind !== "image" && kind !== "pdf")
      )
        throw new TypeError("A document type accepts images and/or PDF files");
      return {
        key: entry.key,
        label: label(entry.label, 40, "Document type label"),
        accept: entry.accept as ("image" | "pdf")[],
      };
    });
    if (new Set(categories.map((item) => item.key)).size !== categories.length)
      throw new TypeError("Document type keys must be unique");
    result.attachmentCategories = categories;
  }
  if (input.evidence !== undefined) {
    const value = object(
      input.evidence,
      ["beforePhotoRequired", "afterPhotoRequired"],
      "evidence",
    );
    result.evidence = {
      beforePhotoRequired: flag(value.beforePhotoRequired, "Before photo"),
      afterPhotoRequired: flag(value.afterPhotoRequired, "After photo"),
    };
  }
  return result;
}

export async function getServiceWorkflowPolicy(
  sql: postgres.TransactionSql,
): Promise<ServiceWorkflowPolicy> {
  const rows = await sql<
    { policy: unknown }[]
  >`SELECT service.current_workflow_policy() AS policy`;
  return parseServiceWorkflowPolicy(rows[0]?.policy);
}

export interface ServiceQueueItem {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly faultDescription: string;
  readonly status: string;
  readonly priority: string;
  readonly customerName: string;
  readonly storeName: string | null;
  readonly chainName: string | null;
  readonly assignedTechnicianId: string | null;
  readonly assignedTechnicianName: string | null;
  readonly updatedAt: string;
}
export async function listServiceQueue(
  sql: postgres.TransactionSql,
  view: "available" | "mine" = "available",
): Promise<{
  items: readonly ServiceQueueItem[];
  policy: ServiceWorkflowPolicy;
}> {
  const rows = await sql<
    { item: ServiceQueueItem }[]
  >`SELECT item FROM service.list_assignment_queue(${view}) item`;
  return {
    items: rows.map((row) => row.item),
    policy: await getServiceWorkflowPolicy(sql),
  };
}
export async function assignServiceCase(
  sql: postgres.TransactionSql,
  caseId: string,
  technicianId: string | null = null,
  reason: string | null = null,
): Promise<{ caseId: string; technicianId: string; visitId: string }> {
  const rows = await sql<
    { receipt: { caseId: string; technicianId: string; visitId: string } }[]
  >`SELECT service.assign_case(${caseId}::uuid, ${technicianId}::uuid, ${reason}) AS receipt`;
  if (!rows[0]) throw new TypeError("Assignment was not saved");
  return rows[0].receipt;
}

export interface ServiceDirectory {
  readonly chains: readonly { id: string; name: string }[];
  readonly stores: readonly {
    id: string;
    chainId: string | null;
    chainName: string | null;
    name: string;
    address: string | null;
    contactId: string | null;
  }[];
}
export async function getServiceDirectory(
  sql: postgres.TransactionSql,
): Promise<ServiceDirectory> {
  const chains = await sql<
    { id: string; name: string }[]
  >`SELECT id,name FROM crm.service_chains WHERE active ORDER BY name,id LIMIT 1000`;
  const stores = await sql<
    {
      id: string;
      chainId: string | null;
      chainName: string | null;
      name: string;
      address: string | null;
      contactId: string | null;
    }[]
  >`
    SELECT location.id,location.chain_id AS "chainId",chain.name AS "chainName",location.name,location.address,location.customer_contact_id AS "contactId"
    FROM crm.service_locations location LEFT JOIN crm.service_chains chain ON chain.tenant_id=location.tenant_id AND chain.id=location.chain_id
    WHERE location.archived_at IS NULL ORDER BY chain.name,location.name,location.id LIMIT 2000`;
  return { chains, stores };
}
export async function saveServiceDirectoryEntry(
  sql: postgres.TransactionSql,
  input: {
    kind: "chain" | "store";
    name: string;
    chainId?: string | null;
    contactId?: string | null;
    address?: string | null;
  },
): Promise<string> {
  const name = input.name.trim();
  if (!name || name.length > 160)
    throw new TypeError("Directory name must contain 1–160 characters");
  const rows =
    input.kind === "chain"
      ? await sql<
          { id: string }[]
        >`INSERT INTO crm.service_chains(tenant_id,name) VALUES(platform.current_tenant_id(),${name}) RETURNING id`
      : await sql<
          { id: string }[]
        >`INSERT INTO crm.service_locations(tenant_id,name,chain_id,customer_contact_id,address) VALUES(platform.current_tenant_id(),${name},${input.chainId ?? null}::uuid,${input.contactId ?? null}::uuid,${input.address ?? null}) RETURNING id`;
  if (!rows[0]) throw new TypeError("Directory entry was not saved");
  return rows[0].id;
}
