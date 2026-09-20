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
export interface ServiceWorkflowPolicy {
  readonly version: 1;
  readonly requiredIntakeFields: readonly IntakeRequiredField[];
  readonly photoPolicy: "optional" | "requested" | "required";
  readonly selfAssignmentEnabled: boolean;
  readonly requiredReportFields: readonly ServiceReportField[];
}
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
  };
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
