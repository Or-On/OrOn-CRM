/**
 * The one explicit execution configuration for a single interaction.
 *
 * Everything the runtime needs to act as the agent an operator actually chose
 * is resolved once, server-side, before the model is consulted: which tenant,
 * which contact, which interaction, which *exact* published agent version, its
 * prompt, the actions it holds, the reviewed field schema it collects against,
 * and where that binding came from. Nothing downstream re-derives any of it.
 *
 * Two rules give the contract its value:
 *
 *  - An explicit assignment is never substituted. Not by the tenant default,
 *    not by the first matching flow, not by another agent with a compatible
 *    voice. When the pinned version cannot run, resolution fails with a reason
 *    rather than quietly falling back to a generic agent.
 *  - The business definition is pinned when the interaction is admitted. A
 *    newer draft published mid-call does not change what the call is doing;
 *    revoked authorisation does stop it. Eligibility is rechecked before side
 *    effects, the pinned definition is not.
 *
 * Credentials never appear here. The contract is safe to hold in memory for the
 * life of an interaction and, through {@link executionContractDiagnostics},
 * safe to log.
 *
 * The voice runtime resolves the same contract in Python
 * (`dispatcher_runtime.persistence.get_voice_configuration`). The field names
 * are deliberately identical, and `execution-contract.parity.test.ts` asserts
 * they have not drifted apart.
 */

import { createHash } from "node:crypto";

import {
  capabilityChannelConflicts,
  effectiveCapabilities,
  parseAgentCapabilities,
  type AgentCapability,
} from "./agent-capabilities.js";
import type { SupportedChannel } from "./cross-channel.js";
import { parseLeadFieldSchema, type LeadFieldSchema } from "./lead-schema.js";

import type postgres from "postgres";

/**
 * How the runtime arrived at this agent. An operator reading a diagnostic line
 * must be able to tell "the agent I assigned" from "the tenant default".
 */
export const assignmentSources = [
  "explicit_assignment",
  "tenant_default",
  "flow_binding",
  "handoff",
] as const;
export type AssignmentSource = (typeof assignmentSources)[number];

export interface PinnedLeadFieldSchema {
  readonly id: string;
  readonly version: number;
  readonly schema: LeadFieldSchema;
}

export interface AgentExecutionContract {
  readonly tenantId: string;
  readonly contactId: string;
  readonly channel: SupportedChannel;
  readonly interaction: {
    readonly kind: "whatsapp_conversation" | "voice_session";
    readonly id: string;
    /** Fences a superseded worker after a handover or re-ownership. */
    readonly ownershipEpoch: string | null;
  };
  readonly agentProfileId: string;
  readonly agentProfileVersionId: string;
  readonly agentVersion: number;
  readonly agentPrompt: string;
  /** How the agent names itself. Tenant identity is decided elsewhere. */
  readonly roleTitle: string | null;
  /** Granted capabilities, already expanded by their implications. */
  readonly capabilities: readonly AgentCapability[];
  readonly leadFieldSchema: PinnedLeadFieldSchema | null;
  readonly locale: string;
  readonly flow: {
    readonly definitionId: string;
    readonly version: number;
  } | null;
  readonly assignmentSource: AssignmentSource;
  /** Set when this interaction continues an earlier one on another channel. */
  readonly originatingConversationId: string | null;
  readonly handoffId: string | null;
  readonly leadId: string | null;
  /** The operator whose authority the agent acts under, never the model. */
  readonly authorizedUserId: string;
}

export class ExecutionContractError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "ExecutionContractError";
    this.reason = reason;
  }
}

/** The columns a caller must already have read from the pinned version row. */
export interface AgentVersionRow {
  readonly agentProfileId: string;
  readonly agentProfileVersionId: string;
  readonly version: number;
  readonly systemPrompt: string;
  readonly locale: string;
  readonly channelCapabilities: readonly string[];
  readonly toolPermissions: unknown;
  readonly channelConfiguration: Record<string, unknown> | null;
  readonly publishedAt: Date | string | null;
  readonly validationStatus: string;
}

function configuredText(
  configuration: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = configuration?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** The lead field schema a version is pinned to, if it is pinned to one. */
export function pinnedLeadFieldSchemaId(row: AgentVersionRow): string | null {
  return configuredText(row.channelConfiguration, "leadFieldSchemaId");
}

/**
 * Load a reviewed field schema by ID under the caller's tenant context.
 *
 * Reading it here rather than accepting one from the caller is what stops a
 * later edit from changing a running interaction's questions: the row is
 * immutable, and a revision is a new row with a new ID.
 */
export async function loadLeadFieldSchema(
  sql: postgres.TransactionSql,
  schemaId: string,
): Promise<PinnedLeadFieldSchema> {
  const rows = await sql<
    { id: string; version: number; definition: unknown }[]
  >`
    SELECT id, version, definition FROM crm.lead_field_schemas
    WHERE id=${schemaId}::uuid AND published_at IS NOT NULL
  `;
  const row = rows[0];
  if (row === undefined)
    throw new ExecutionContractError(
      "pinned lead field schema is unavailable in this tenant",
    );
  return {
    id: row.id,
    version: row.version,
    schema: parseLeadFieldSchema(row.definition),
  };
}

export interface ExecutionContractInput {
  readonly tenantId: string;
  readonly contactId: string;
  readonly channel: SupportedChannel;
  readonly interaction: AgentExecutionContract["interaction"];
  readonly authorizedUserId: string;
  readonly assignmentSource: AssignmentSource;
  readonly version: AgentVersionRow;
  readonly leadFieldSchema?: PinnedLeadFieldSchema | null;
  readonly flow?: AgentExecutionContract["flow"];
  readonly originatingConversationId?: string | null;
  readonly handoffId?: string | null;
  readonly leadId?: string | null;
  /**
   * The version the caller believes it assigned. Supplying it turns a silent
   * substitution into a refusal: if the row that was actually loaded is a
   * different version, the interaction stops instead of running the wrong
   * agent with a plausible voice.
   */
  readonly expectedAgentVersionId?: string | undefined;
}

/**
 * Build the contract from a version row the caller has already locked.
 *
 * Nothing here is advisory. An unpublished version, an unvalidated version, a
 * version that does not cover the channel, or a capability that channel cannot
 * execute each raise rather than degrade.
 */
export function buildAgentExecutionContract(
  input: ExecutionContractInput,
): AgentExecutionContract {
  const { version } = input;
  if (
    input.expectedAgentVersionId !== undefined &&
    input.expectedAgentVersionId !== version.agentProfileVersionId
  )
    throw new ExecutionContractError(
      "resolved agent version does not match the assigned one",
    );
  if (version.publishedAt === null)
    throw new ExecutionContractError(
      "assigned agent version is a draft and cannot run an interaction",
    );
  if (version.validationStatus !== "valid")
    throw new ExecutionContractError(
      `assigned agent version is ${version.validationStatus}, not valid`,
    );
  if (!version.channelCapabilities.includes(input.channel))
    throw new ExecutionContractError(
      `assigned agent version does not support the ${input.channel} channel`,
    );
  const capabilities = effectiveCapabilities(
    parseAgentCapabilities(version.toolPermissions),
  );
  const conflicts = capabilityChannelConflicts(capabilities, [input.channel]);
  if (conflicts.length > 0)
    throw new ExecutionContractError(
      `capability not executable on ${input.channel}: ${conflicts
        .map(({ capability }) => capability)
        .join(", ")}`,
    );
  const schemaId = pinnedLeadFieldSchemaId(version);
  const leadFieldSchema = input.leadFieldSchema ?? null;
  if (schemaId !== null && leadFieldSchema === null)
    throw new ExecutionContractError(
      "assigned agent pins a lead field schema that was not loaded",
    );
  if (
    leadFieldSchema !== null &&
    schemaId !== null &&
    leadFieldSchema.id !== schemaId
  )
    throw new ExecutionContractError(
      "loaded lead field schema is not the one this agent version pins",
    );
  const prompt = version.systemPrompt.trim();
  if (prompt === "")
    throw new ExecutionContractError("assigned agent version has no prompt");
  return {
    tenantId: input.tenantId,
    contactId: input.contactId,
    channel: input.channel,
    interaction: input.interaction,
    agentProfileId: version.agentProfileId,
    agentProfileVersionId: version.agentProfileVersionId,
    agentVersion: version.version,
    agentPrompt: prompt,
    roleTitle: configuredText(version.channelConfiguration, "roleTitle"),
    capabilities,
    leadFieldSchema,
    locale: version.locale,
    flow: input.flow ?? null,
    assignmentSource: input.assignmentSource,
    originatingConversationId: input.originatingConversationId ?? null,
    handoffId: input.handoffId ?? null,
    leadId: input.leadId ?? null,
    authorizedUserId: input.authorizedUserId,
  };
}

/**
 * A stable fingerprint of the static configuration this interaction runs.
 *
 * Two interactions sharing a hash provably ran the same prompt, capabilities
 * and field schema. The prompt is hashed, never included, so the value is safe
 * to record next to an interaction ID.
 */
export function executionConfigurationHash(
  contract: AgentExecutionContract,
): string {
  return createHash("sha256")
    .update(contract.agentProfileVersionId)
    .update("\0")
    .update(contract.agentPrompt)
    .update("\0")
    .update(contract.capabilities.join(","))
    .update("\0")
    .update(contract.roleTitle ?? "")
    .update("\0")
    .update(
      contract.leadFieldSchema === null
        ? ""
        : `${contract.leadFieldSchema.id}@${String(contract.leadFieldSchema.version)}`,
    )
    .update("\0")
    .update(contract.locale)
    .digest("hex")
    .slice(0, 32);
}

export interface ExecutionContractDiagnostics {
  readonly agentProfileId: string;
  readonly agentVersionId: string;
  readonly agentVersion: number;
  readonly channel: SupportedChannel;
  readonly interactionKind: AgentExecutionContract["interaction"]["kind"];
  readonly interactionId: string;
  readonly assignmentSource: AssignmentSource;
  readonly capabilities: readonly AgentCapability[];
  readonly leadFieldSchemaId: string | null;
  readonly flowDefinitionId: string | null;
  readonly flowVersion: number | null;
  readonly configurationHash: string;
}

/**
 * What may be written to an ordinary log: identifiers, versions and a hash.
 * The prompt, the customer, and anything they said stay out.
 */
export function executionContractDiagnostics(
  contract: AgentExecutionContract,
): ExecutionContractDiagnostics {
  return {
    agentProfileId: contract.agentProfileId,
    agentVersionId: contract.agentProfileVersionId,
    agentVersion: contract.agentVersion,
    channel: contract.channel,
    interactionKind: contract.interaction.kind,
    interactionId: contract.interaction.id,
    assignmentSource: contract.assignmentSource,
    capabilities: contract.capabilities,
    leadFieldSchemaId: contract.leadFieldSchema?.id ?? null,
    flowDefinitionId: contract.flow?.definitionId ?? null,
    flowVersion: contract.flow?.version ?? null,
    configurationHash: executionConfigurationHash(contract),
  };
}

/**
 * A preview of the resolved configuration for an authorised operator.
 *
 * It includes the effective instructions on purpose — that is the point of a
 * preview — and so must only ever be returned behind the same authorisation as
 * editing the agent. It is not what gets logged; that is
 * {@link executionContractDiagnostics}.
 */
export interface ExecutionContractPreview extends ExecutionContractDiagnostics {
  readonly agentPrompt: string;
  readonly roleTitle: string | null;
  readonly locale: string;
  readonly leadFields: readonly string[];
}

export function executionContractPreview(
  contract: AgentExecutionContract,
): ExecutionContractPreview {
  return {
    ...executionContractDiagnostics(contract),
    agentPrompt: contract.agentPrompt,
    roleTitle: contract.roleTitle,
    locale: contract.locale,
    leadFields:
      contract.leadFieldSchema?.schema.fields.map((field) => field.key) ?? [],
  };
}
