/**
 * The lead tool surface offered to a WhatsApp model, and the only path from its
 * tool calls to a durable write.
 *
 * Tool names, descriptions and argument shapes come from the canonical lead
 * contract, which the Python voice runtime reads too, so both channels
 * advertise the same actions; both then commit through the same `platform.*`
 * functions. Three properties matter:
 *
 *  - Only capabilities the operator published are advertised, so an agent that
 *    merely talks about saving leads is never handed the means to do it.
 *  - No argument names a tenant, contact or lead. Those come from the binding
 *    the runtime resolved before the model was consulted.
 *  - Operation identity is derived from the interaction and the turn, so a
 *    retry after a restart recognises its own committed write. A fresh tool-call
 *    ID would not.
 */

import { createHash } from "node:crypto";

import {
  effectiveCapabilities,
  hasCapability,
  type AgentCapability,
} from "./agent-capabilities.js";
import { leadCaptureContract } from "./lead-capture-contract.generated.js";
import type {
  LeadFieldObservationInput,
  LeadFieldSchema,
} from "./lead-schema.js";
import { leadFieldStates } from "./lead-schema.js";
import {
  finalizeLeadCollection,
  readLeadState,
  requestLeadFollowUp,
  saveLeadFields,
  type LeadBinding,
  type LeadReceipt,
  type LeadSnapshot,
} from "./leads.js";
import type { JsonValue } from "./types.js";

import type postgres from "postgres";

const toolContract = leadCaptureContract.tools;

export const leadToolNames = toolContract.definitions.map(
  (definition) => definition.name,
) as readonly (typeof toolContract.definitions)[number]["name"][];
export type LeadToolName = (typeof toolContract.definitions)[number]["name"];

export interface LeadToolDescriptor {
  readonly name: LeadToolName;
  readonly description: string;
  readonly capability: AgentCapability;
  readonly mutating: boolean;
  readonly parameters: JsonValue;
}

/**
 * The observation shape advertised to a model. `strictNullable` produces the
 * variant structured-output modes demand — every property required, absent
 * values expressed as null — from the same reviewed field list, so the
 * advertisement can never enumerate a field the validator would reject.
 */
export function leadObservationItemSchema(
  schema: LeadFieldSchema,
  options: { readonly strictNullable?: boolean } = {},
): JsonValue {
  const strict = options.strictNullable === true;
  const optional = (type: "string" | "boolean"): readonly string[] | string =>
    strict ? [type, "null"] : type;
  const describe = toolContract.observationItem;
  return {
    type: "object",
    additionalProperties: false,
    required: strict
      ? ["key", "state", "value", "currency", "confirmed", "sourceReference"]
      : ["key", "state"],
    properties: {
      key: {
        type: "string",
        enum: schema.fields.map((field) => field.key),
        description: describe.key,
      },
      state: {
        type: "string",
        enum: [...leadFieldStates],
        description: describe.state,
      },
      value: { type: optional("string"), description: describe.value },
      currency: { type: optional("string"), description: describe.currency },
      confirmed: { type: optional("boolean"), description: describe.confirmed },
      sourceReference: {
        type: optional("string"),
        description: describe.sourceReference,
      },
    },
  };
}

/** JSON Schema for a tool's scalar arguments, as the contract declares them. */
function argumentSchema(
  definition: (typeof toolContract.definitions)[number],
  schema: LeadFieldSchema,
): JsonValue {
  if (definition.name === "lead_save_fields")
    return {
      type: "object",
      additionalProperties: false,
      required: ["observations"],
      properties: {
        observations: {
          type: "array",
          minItems: 1,
          maxItems: toolContract.maxObservationsPerCall,
          items: leadObservationItemSchema(schema),
        },
      },
    };
  const entries = Object.entries(definition.arguments) as [
    string,
    {
      readonly type: string;
      readonly required: boolean;
      readonly maxLength?: number;
      readonly description?: string;
    },
  ][];
  const required = entries
    .filter(([, argument]) => argument.required)
    .map(([name]) => name);
  return {
    type: "object",
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required }),
    properties: Object.fromEntries(
      // ``required`` is stated once, for the object, never on the property.
      entries.map(([name, argument]) => [
        name,
        {
          type: argument.type,
          ...(argument.maxLength === undefined
            ? {}
            : { maxLength: argument.maxLength }),
          ...(argument.description === undefined
            ? {}
            : { description: argument.description }),
        },
      ]),
    ),
  };
}

/**
 * Descriptors for exactly the capabilities this published version holds, with
 * the field enumeration taken from the reviewed schema the lead is pinned to.
 */
export function leadToolDescriptors(
  capabilities: readonly AgentCapability[],
  schema: LeadFieldSchema,
): readonly LeadToolDescriptor[] {
  const granted = effectiveCapabilities(capabilities);
  return toolContract.definitions
    .filter((definition) => hasCapability(granted, definition.capability))
    .map((definition) => ({
      name: definition.name,
      description: definition.description,
      capability: definition.capability,
      mutating: definition.mutating,
      parameters: argumentSchema(definition, schema),
    }));
}

export function isLeadToolName(value: unknown): value is LeadToolName {
  return (
    typeof value === "string" && leadToolNames.includes(value as LeadToolName)
  );
}

/**
 * Durable identity for the interaction and the turn a tool call belongs to.
 * Both must survive a worker restart; a value regenerated per process would
 * turn a safe retry into a duplicate write.
 */
export interface LeadToolContext {
  readonly leadId: string;
  readonly interactionKey: string;
  readonly turnKey: string;
  readonly schema: LeadFieldSchema;
  /**
   * The accepted message or turn this call answers. It is the provenance
   * recorded for the values saved here: a model may describe where a value
   * came from, but it does not get to decide what the record says.
   */
  readonly sourceReferenceId?: string;
  /**
   * Earlier accepted references from this same interaction that the model may
   * legitimately cite — nothing else. A citation outside this set falls back
   * to the current turn, because unverifiable provenance is worse than plain
   * provenance.
   */
  readonly acceptedReferences?: readonly string[];
}

export class LeadToolError extends Error {
  readonly tool: string;
  readonly reason: string;
  constructor(tool: string, reason: string) {
    super(`${tool}: ${reason}`);
    this.name = "LeadToolError";
    this.tool = tool;
    this.reason = reason;
  }
}

export function leadOperationKey(
  context: Pick<LeadToolContext, "interactionKey" | "turnKey">,
  tool: LeadToolName,
  argumentsJson: string,
): string {
  const digest = createHash("sha256")
    .update(context.interactionKey)
    .update("\0")
    .update(context.turnKey)
    .update("\0")
    .update(tool)
    .update("\0")
    .update(argumentsJson)
    .digest("hex")
    .slice(0, 40);
  return `${tool}:${digest}`;
}

function record(
  value: unknown,
  tool: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new LeadToolError(tool, "arguments must be an object");
  return value as Readonly<Record<string, unknown>>;
}

function requiredText(
  input: Readonly<Record<string, unknown>>,
  key: string,
  tool: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "")
    throw new LeadToolError(tool, `${key} is required`);
  return value;
}

function optionalText(
  input: Readonly<Record<string, unknown>>,
  key: string,
  tool: string,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string")
    throw new LeadToolError(tool, `${key} must be text`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseObservations(
  input: Readonly<Record<string, unknown>>,
  tool: string,
  context: LeadToolContext,
): readonly LeadFieldObservationInput[] {
  const raw = input.observations;
  if (!Array.isArray(raw) || raw.length === 0)
    throw new LeadToolError(tool, "at least one observation is required");
  if (raw.length > 20)
    throw new LeadToolError(
      tool,
      "at most 20 observations may be sent at once",
    );
  return raw.map((entry) => {
    const item = record(entry, tool);
    const key = requiredText(item, "key", tool);
    const state = item.state;
    if (
      typeof state !== "string" ||
      !leadFieldStates.includes(state as (typeof leadFieldStates)[number])
    )
      throw new LeadToolError(tool, `${key} has an unsupported state`);
    const confirmed = item.confirmed;
    if (confirmed !== undefined && typeof confirmed !== "boolean")
      throw new LeadToolError(tool, `${key} confirmed must be true or false`);
    const value = optionalText(item, "value", tool);
    const currency = optionalText(item, "currency", tool);
    const cited = optionalText(item, "sourceReference", tool);
    // A cited turn counts only when this interaction really contains it;
    // otherwise the value is attributed to the turn that carried the call.
    const sourceReference =
      cited !== undefined && (context.acceptedReferences ?? []).includes(cited)
        ? cited
        : context.sourceReferenceId;
    return {
      key,
      state: state as (typeof leadFieldStates)[number],
      ...(value === undefined ? {} : { value }),
      ...(currency === undefined ? {} : { currency }),
      ...(sourceReference === undefined
        ? {}
        : { sourceReferenceId: sourceReference }),
      // A model asserting confirmation is the weakest claim available, so it
      // can only reach customer_confirmed, never human_verified.
      confirmation:
        confirmed === true
          ? ("customer_confirmed" as const)
          : ("unconfirmed" as const),
    };
  });
}

/** What the model is told. Internal identifiers stay out of the wording. */
export interface LeadToolResult {
  readonly tool: LeadToolName;
  readonly ok: true;
  readonly receipt?: LeadReceipt;
  readonly collected: readonly {
    readonly key: string;
    readonly state: string;
    readonly value: string | null;
  }[];
  readonly missingRequired: readonly string[];
  readonly rejected?: readonly {
    readonly key: string;
    readonly reason: string;
  }[];
  readonly status: string;
}

function summarize(
  tool: LeadToolName,
  lead: LeadSnapshot,
  extra: {
    readonly receipt?: LeadReceipt;
    readonly rejected?: readonly {
      readonly key: string;
      readonly reason: string;
    }[];
  } = {},
): LeadToolResult {
  return {
    tool,
    ok: true,
    ...(extra.receipt === undefined ? {} : { receipt: extra.receipt }),
    collected: lead.fields
      .filter((field) => field.supersededAt === null)
      .map((field) => ({
        key: field.key,
        state: field.state,
        value: field.normalizedValue,
      })),
    missingRequired: lead.completeness?.missing ?? [],
    ...(extra.rejected === undefined || extra.rejected.length === 0
      ? {}
      : { rejected: extra.rejected }),
    status: lead.status,
  };
}

/**
 * Execute one lead tool call. The caller supplies the binding; the model
 * supplies only `name` and `input`, and an unauthorized or unknown name is
 * refused before any statement runs.
 */
export async function executeLeadTool(
  sql: postgres.TransactionSql,
  binding: LeadBinding,
  context: LeadToolContext,
  name: string,
  input: unknown,
): Promise<LeadToolResult> {
  if (!isLeadToolName(name))
    throw new LeadToolError(name, "is not an available action");
  const descriptor = leadToolDescriptors(
    binding.capabilities,
    context.schema,
  ).find((candidate) => candidate.name === name);
  if (descriptor === undefined)
    throw new LeadToolError(name, "is not enabled for this agent");
  const args = input === undefined || input === null ? {} : record(input, name);
  if (name === "lead_read_state")
    return summarize(name, await readLeadState(sql, binding, context.leadId));
  if (name === "lead_save_fields") {
    const observations = parseObservations(args, name, context);
    const result = await saveLeadFields(sql, binding, {
      leadId: context.leadId,
      operationKey: leadOperationKey(
        context,
        name,
        JSON.stringify(observations),
      ),
      observations,
    });
    return summarize(name, result.lead, {
      receipt: result.receipt,
      rejected: result.rejected,
    });
  }
  if (name === "lead_finalize_collection") {
    const summary = requiredText(args, "summary", name);
    const nextAction = optionalText(args, "nextAction", name);
    const result = await finalizeLeadCollection(sql, binding, {
      leadId: context.leadId,
      operationKey: leadOperationKey(
        context,
        name,
        JSON.stringify({ summary, nextAction: nextAction ?? null }),
      ),
      summary,
      ...(nextAction === undefined ? {} : { nextAction }),
    });
    return summarize(name, result.lead, { receipt: result.receipt });
  }
  const note = requiredText(args, "note", name);
  const dueAt = optionalText(args, "dueAt", name);
  const result = await requestLeadFollowUp(sql, binding, {
    leadId: context.leadId,
    operationKey: leadOperationKey(
      context,
      name,
      JSON.stringify({ note, dueAt: dueAt ?? null }),
    ),
    note,
    ...(dueAt === undefined ? {} : { dueAt }),
  });
  return summarize(name, result.lead, { receipt: result.receipt });
}
