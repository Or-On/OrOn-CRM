import {
  compatibleModelParameters,
  assertCompatibleFallback,
} from "@or-on/config";
import { randomUUID } from "node:crypto";
import { budgetUntrustedPromptContext } from "./prompt-context-budget.js";
import {
  composeWhatsAppInstructions,
  whatsAppActionNames,
  effectiveCapabilities,
  leadFieldStates,
  leadObservationItemSchema,
  type AgentCapability,
  type AgentContextSurfaces,
  type LeadFieldSchema,
  type ServiceWorkflowPolicy,
} from "@or-on/crm";

import {
  conversationReplyCodes,
  safeKnowledgeStatement,
  type ConversationReplyCode,
  type EligibleKnowledgeFact,
} from "./ai-grounding.js";
import {
  tenantBusinessContext,
  type TenantBusinessContext,
} from "./tenant-business-context.js";

export interface WhatsAppAiRequest {
  readonly configuredLocale?: string;
  readonly contextBudgetEnabled?: boolean;
  /** The published agent version's own prompt, verbatim. */
  readonly systemPrompt: string;
  readonly locale: string;
  /** Capabilities the operator published. Absent means a conversation-only agent. */
  readonly capabilities?: readonly AgentCapability[];
  /** The reviewed field schema this interaction's lead is pinned to. */
  readonly lead?: {
    readonly schema: LeadFieldSchema;
    readonly missingRequired: readonly string[];
    /** Durable lifecycle state; absence means no state was supplied, not completion. */
    readonly status?: string;
    /**
     * What is already stored. Supplying it is what stops the agent re-asking a
     * question the customer has answered, on this channel or another one.
     */
    readonly collected?: readonly {
      readonly key: string;
      readonly state: string;
      readonly value: string | null;
    }[];
  };
  /**
   * Outcomes of actions the worker already executed this turn. A save claim is
   * only truthful when a receipt here says so.
   */
  readonly actionReceipts?: readonly WhatsAppActionReceipt[];
  /**
   * The turn has spent its action budget and must end in something the customer
   * can read. The agent keeps its published capabilities — only this turn's
   * envelope stops offering them, so the model is not told it is powerless.
   */
  readonly replyOnly?: boolean;
  readonly tenantDisplayName?: string;
  /** Current tenant-authored facts, not reviewed knowledge or tool grants. */
  readonly businessProfile?: TenantBusinessContext;
  readonly knowledge?: readonly EligibleKnowledgeFact[];
  readonly knowledgeChunks?: readonly {
    readonly documentId: string;
    readonly content: string;
  }[];
  readonly sessionMemory?: string;
  /** Server-authorized form workflow; never inferred from customer text. */
  readonly digitalServiceFormAvailable?: boolean;
  readonly serviceIntake?: {
    readonly workflowPolicy?: ServiceWorkflowPolicy;
    readonly status:
      | "collecting"
      | "awaiting_confirmation"
      | "confirmed"
      | "handed_off"
      | "expired";
    readonly fields: Readonly<Record<string, unknown>>;
    readonly missingFields: readonly string[];
    readonly nationalIdMasked: string | null;
    readonly caseReference: string | null;
    readonly customerResolutionStatus:
      | "unresolved"
      | "reporting_contact"
      | "matched"
      | "created"
      | "conflict"
      | "invalid_phone";
  };
  /** Tenant-scoped database evidence loaded by the worker, never model-authored. */
  readonly contactContext?: {
    readonly contact: {
      readonly name: string;
      readonly email: string | null;
      readonly company: string | null;
      readonly lifecycleStatus: string;
    };
    readonly identity: {
      readonly matchedBy: "verified_whatsapp_identity";
      readonly knownBeforeConversation: boolean;
      readonly firstConversation: boolean;
      readonly missingProfileFields: readonly ("name" | "email" | "company")[];
      /** Validated sender of this interaction, not an inferred contact primary phone. */
      readonly channelPhone?: string;
    };
    readonly notes: readonly {
      readonly text: string;
      readonly occurredAt: string;
    }[];
    readonly previousConversations: readonly {
      readonly summary: string;
      readonly status: string;
      readonly occurredAt: string | null;
    }[];
    readonly tickets: readonly {
      readonly id: string;
      readonly title: string;
      readonly summary: string;
      readonly status: string;
      readonly priority: string;
      readonly occurredAt: string;
    }[];
    readonly voiceSessions: readonly {
      readonly sessionId: string;
      readonly status: string;
      readonly answered: boolean | null;
      readonly outcome: string | null;
      readonly recordingObjectId: string | null;
      readonly transcriptObjectId: string | null;
      readonly occurredAt: string;
    }[];
  };
  readonly messages: readonly {
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly id?: string;
    readonly occurredAt?: string;
    readonly provenance?:
      "caller_report_unverified" | "prior_assistant_unverified";
  }[];
}

export interface WhatsAppActionReceipt {
  readonly validationError?: {
    readonly code: string;
    readonly field: string;
    readonly recoverable: true;
  };
  readonly action: string;
  readonly ok: boolean;
  /** The customer-safe reference the action returned, when it committed. */
  readonly reference: string | null;
  readonly detail: string;
}

export interface WhatsAppLeadObservation {
  readonly key: string;
  readonly state: (typeof leadFieldStates)[number];
  readonly value?: string;
  readonly currency?: string;
  readonly confirmed?: boolean;
  readonly sourceReference?: string;
}

export type WhatsAppAiEscalationReason =
  | "human_requested"
  | "emergency"
  | "safety"
  | "regulated_decision"
  | "insufficient_context"
  | "call_requested";

export type WhatsAppAiDecision =
  | {
      readonly action: "reply";
      readonly text: string;
      readonly replyCode?: ConversationReplyCode;
    }
  | {
      readonly action: "knowledge";
      readonly text: string;
      readonly documentId: string;
      readonly factKey: string;
    }
  | {
      readonly action: "handoff" | "request_call";
      readonly reasonCode: WhatsAppAiEscalationReason;
      readonly text: string;
    }
  | { readonly action: "service_form" }
  | { readonly action: "ticket_open"; readonly subject: string }
  | {
      readonly action: "lead_save";
      readonly observations: readonly WhatsAppLeadObservation[];
    }
  | {
      readonly action: "lead_finalize";
      readonly summary: string;
    }
  | {
      readonly action: "lead_follow_up";
      readonly note: string;
    };

export interface WhatsAppAiUsage {
  readonly eventId?: string;
  readonly model?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly tokenDetails?: ProviderTokenDetails;
}

export interface ProviderTokenDetails {
  readonly cachedInput: number | null;
  readonly audioInput: number | null;
  readonly cachedAudioInput: number | null;
  readonly reasoningOutput: number | null;
  readonly audioOutput: number | null;
}

/** Subsets of the provider totals, never additional billable tokens. Missing means unknown. */
function providerTokenDetails(
  usage: object,
  input: number,
  output: number,
): ProviderTokenDetails {
  const record = usage as Record<string, unknown>;
  const details = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const prompt = details(record.prompt_tokens_details),
    completion = details(record.completion_tokens_details);
  const count = (value: unknown, limit: number): number | null =>
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= limit
      ? value
      : null;
  const cachedInput = count(prompt.cached_tokens, input),
    audioInput = count(prompt.audio_tokens, input);
  return {
    cachedInput,
    audioInput,
    cachedAudioInput: count(
      prompt.cached_audio_tokens,
      Math.min(cachedInput ?? 0, audioInput ?? 0),
    ),
    reasoningOutput: count(completion.reasoning_tokens, output),
    audioOutput: count(completion.audio_tokens, output),
  };
}

export interface WhatsAppAiAttempt {
  readonly staticEffectiveInstructionHash?: string;
  readonly effectiveLocale?: string;
  readonly runtimeInstructionHash?: string;
  readonly compositionVersion?: string;
  readonly eventId: string;
  readonly model: string;
  readonly occurredAt: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number;
  readonly status: "succeeded" | "http_error" | "timeout" | "invalid_response";
  readonly errorCode: string | null;
  readonly tokenDetails?: ProviderTokenDetails;
}

export function providerReportedUsage(
  payload: unknown,
  latencyMs: number,
): WhatsAppAiUsage | undefined {
  if (payload === null || typeof payload !== "object" || !("usage" in payload))
    return undefined;
  const usage = payload.usage;
  if (
    usage === null ||
    typeof usage !== "object" ||
    !("prompt_tokens" in usage) ||
    !("completion_tokens" in usage)
  )
    return undefined;
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0
  )
    return undefined;
  return {
    inputTokens,
    outputTokens,
    latencyMs: Math.min(2147483647, Math.max(0, Math.round(latencyMs))),
    tokenDetails: providerTokenDetails(usage, inputTokens, outputTokens),
  };
}

export interface WhatsAppAiProvider {
  readonly accountingMode?: "attempts";
  acknowledgeAttempt?(attempt: WhatsAppAiAttempt): void;
  decide(
    request: WhatsAppAiRequest,
    onUsage?: (usage: WhatsAppAiUsage) => Promise<void>,
    onAttempt?: (attempt: WhatsAppAiAttempt) => Promise<void>,
    beforeAttempt?: () => Promise<void>,
  ): Promise<WhatsAppAiDecision>;
}

export class WhatsAppAiProviderError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = "WhatsAppAiProviderError";
  }
}

const escalationReasons = new Set<WhatsAppAiEscalationReason>([
  "human_requested",
  "emergency",
  "safety",
  "regulated_decision",
  "insufficient_context",
  "call_requested",
]);

const conversationDecisionKeys = [
  "action",
  "text",
  "reasonCode",
  "replyCode",
  "documentId",
  "factKey",
] as const;

/**
 * The action envelope for this interaction. Lead actions appear only when the
 * operator published the matching capability, so a prompt that merely talks
 * about saving leads cannot reach one, and an action the agent does not hold
 * is refused when parsing rather than merely discouraged in prose.
 */
const modelReplyCodes = conversationReplyCodes.filter(
  (code) =>
    !["greeting", "clarify", "clarify_detail", "clarify_rephrase"].includes(
      code,
    ),
);

function decisionSchemaFor(
  capabilities: readonly AgentCapability[],
  lead: WhatsAppAiRequest["lead"],
  options: {
    readonly withActions?: boolean;
    readonly digitalServiceFormAvailable?: boolean;
  } = {},
): {
  readonly schema: Record<string, unknown>;
  readonly keys: readonly string[];
} {
  const actions = whatsAppActionNames(capabilities, {
    ...options,
    hasLead: lead !== undefined,
    missingRequiredCount: lead?.missingRequired.length ?? 0,
  });
  const properties: Record<string, unknown> = {
    action: { type: "string", enum: actions },
    text: { type: ["string", "null"] },
    replyCode: {
      type: ["string", "null"],
      // Generic greetings/clarifications are delivery fallbacks, not a shortcut
      // that may replace an answer to a customer's already stated request.
      enum: [...modelReplyCodes, null],
    },
    documentId: { type: ["string", "null"] },
    factKey: { type: ["string", "null"] },
    reasonCode: {
      type: ["string", "null"],
      enum: [
        "human_requested",
        "emergency",
        "safety",
        "regulated_decision",
        "insufficient_context",
        "call_requested",
        null,
      ],
    },
  };
  const keys: string[] = [...conversationDecisionKeys];
  if (capabilities.includes("ticket.open") && options.withActions !== false) {
    properties.ticketSubject = {
      type: ["string", "null"],
      minLength: 1,
      maxLength: 240,
    };
    keys.push("ticketSubject");
  }
  if (lead !== undefined && options.withActions !== false) {
    if (capabilities.includes("lead.write")) {
      properties.leadObservations = {
        type: ["array", "null"],
        minItems: 1,
        maxItems: 12,
        items: leadObservationItemSchema(lead.schema, { strictNullable: true }),
      };
      keys.push("leadObservations");
    }
    if (
      capabilities.includes("lead.finalize") &&
      lead.missingRequired.length === 0
    ) {
      properties.leadSummary = { type: ["string", "null"], maxLength: 4000 };
      keys.push("leadSummary");
    }
    if (capabilities.includes("lead.follow_up")) {
      properties.leadNote = { type: ["string", "null"], maxLength: 1000 };
      keys.push("leadNote");
    }
  }
  return {
    schema: {
      type: "object",
      additionalProperties: false,
      properties,
      required: keys,
    },
    keys,
  };
}

/**
 * How to answer on this channel. Delivery and envelope rules only — the
 * business objective belongs to the agent's own prompt.
 */

/**
 * Accept observations only for fields the operator reviewed, in a state the
 * domain defines. A model naming any other field is a rejected turn, never a
 * silently dropped value.
 */
function parseLeadObservations(
  raw: unknown,
  schema: LeadFieldSchema | undefined,
): readonly WhatsAppLeadObservation[] | undefined {
  if (schema === undefined || !Array.isArray(raw) || raw.length === 0)
    return undefined;
  if (raw.length > 12) return undefined;
  const allowed = new Set(schema.fields.map((field) => field.key));
  const observations: WhatsAppLeadObservation[] = [];
  for (const entry of raw as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return undefined;
    const item = entry as Readonly<Record<string, unknown>>;
    const key = item.key;
    const state = item.state;
    if (typeof key !== "string" || !allowed.has(key)) return undefined;
    if (
      typeof state !== "string" ||
      !leadFieldStates.includes(state as (typeof leadFieldStates)[number])
    )
      return undefined;
    const value =
      typeof item.value === "string" ? item.value.trim() : undefined;
    const currency =
      typeof item.currency === "string" ? item.currency.trim() : undefined;
    const sourceReference =
      typeof item.sourceReference === "string" && item.sourceReference.trim()
        ? item.sourceReference.trim()
        : undefined;
    if ((value?.length ?? 0) > 1000) return undefined;
    observations.push({
      key,
      state: state as (typeof leadFieldStates)[number],
      ...(value === undefined || value === "" ? {} : { value }),
      ...(currency === undefined || currency === "" ? {} : { currency }),
      ...(item.confirmed === true ? { confirmed: true } : {}),
      ...(sourceReference === undefined ? {} : { sourceReference }),
    });
  }
  return observations;
}

function surfacesFor(request: WhatsAppAiRequest): AgentContextSurfaces {
  const contact = request.contactContext;
  return {
    ...(contact === undefined ? {} : { contactContext: true }),
    ...(contact !== undefined &&
    (contact.tickets.length > 0 || contact.previousConversations.length > 0)
      ? { tickets: true }
      : {}),
    ...(request.serviceIntake === undefined ? {} : { serviceIntake: true }),
    ...(request.lead === undefined ? {} : { leadCollection: true }),
    ...((request.knowledge?.length ?? 0) > 0 ? { knowledge: true } : {}),
  };
}

function completionText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const contentParts: readonly unknown[] = content;
  const parts = contentParts
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const text = (part as Readonly<Record<string, unknown>>).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean);
  return parts.length === 0 ? undefined : parts.join("");
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim().replace(/^\uFEFF/u, "");
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function boundedKnowledge(
  facts: readonly EligibleKnowledgeFact[],
): readonly EligibleKnowledgeFact[] {
  let remaining = 12000;
  return facts
    .filter((fact) => {
      if (
        !safeKnowledgeStatement(fact.value) ||
        facts.some(
          (other) =>
            other.factKey === fact.factKey && other.value !== fact.value,
        )
      )
        return false;
      remaining -= fact.value.length + fact.factKey.length + 160;
      return remaining >= 0;
    })
    .slice(0, 40);
}

function boundedHistory(
  messages: WhatsAppAiRequest["messages"],
): WhatsAppAiRequest["messages"] {
  let remaining = 16000;
  return messages
    .slice(-30)
    .reverse()
    .flatMap((message) => {
      if (remaining <= 0) return [];
      const text = message.text.slice(0, Math.min(1800, remaining));
      remaining -= text.length;
      return [
        {
          ...message,
          text,
          ...(text.length < message.text.length ? { truncated: true } : {}),
        },
      ];
    })
    .reverse();
}

function serializeProviderContext(
  context: Record<string, unknown>,
  enabled: boolean,
): string {
  if (!enabled) return JSON.stringify(context);
  // Bound untrusted context while retaining published instructions, verified
  // business state and actual action receipts outside this separate budget.
  return JSON.stringify({
    kind: context.kind,
    ...budgetUntrustedPromptContext(context),
    serviceIntake: context.serviceIntake,
    leadCollection: context.leadCollection,
    actionReceipts: context.actionReceipts,
  });
}

export class OpenAiCompatibleChatProvider implements WhatsAppAiProvider {
  public readonly accountingMode = "attempts" as const;
  private readonly unrecordedUsage: WhatsAppAiUsage[] = [];
  private readonly unrecordedAttempts: WhatsAppAiAttempt[] = [];
  public pendingAttempts(): readonly WhatsAppAiAttempt[] {
    return [...this.unrecordedAttempts];
  }
  public acknowledgeAttempt(attempt: WhatsAppAiAttempt): void {
    const index = this.unrecordedAttempts.indexOf(attempt);
    if (index >= 0) this.unrecordedAttempts.splice(index, 1);
  }

  /** Accounting failures remain available for reconciliation, never as zero usage. */
  public drainUnrecordedUsage(): readonly WhatsAppAiUsage[] {
    return this.unrecordedUsage.splice(0);
  }
  public pendingUsage(): readonly WhatsAppAiUsage[] {
    return [...this.unrecordedUsage];
  }
  public acknowledgeUsage(usage: WhatsAppAiUsage): void {
    const index = this.unrecordedUsage.indexOf(usage);
    if (index >= 0) this.unrecordedUsage.splice(index, 1);
  }
  public constructor(
    private readonly options: {
      readonly apiKey: string;
      readonly baseUrl: string;
      readonly model: string;
      readonly fallbackModel?: string;
      readonly onUsageRecordingFailure?: (
        usage: WhatsAppAiUsage,
      ) => Promise<void>;
      readonly timeoutMs?: number;
      readonly temperature?: number;
      readonly maxTokens?: number;
    },
  ) {
    assertCompatibleFallback(
      options.baseUrl,
      options.model,
      options.fallbackModel,
    );
  }

  public async decide(
    request: WhatsAppAiRequest,
    onUsage?: (usage: WhatsAppAiUsage) => Promise<void>,
    onAttempt?: (attempt: WhatsAppAiAttempt) => Promise<void>,
    beforeAttempt?: () => Promise<void>,
  ): Promise<WhatsAppAiDecision> {
    const latestReceipt = request.actionReceipts?.at(-1);
    if (
      latestReceipt?.ok === false &&
      ["lead_save", "lead_finalize", "lead_follow_up"].includes(
        latestReceipt.action,
      )
    )
      return { action: "reply", replyCode: "action_failed", text: "" };
    if (
      this.unrecordedUsage.length >= 98 ||
      this.unrecordedAttempts.length >= 98
    )
      throw new WhatsAppAiProviderError("ai_usage_reconciliation_full", false);
    try {
      return await this.decideAttempt(
        request,
        onUsage,
        false,
        onAttempt,
        beforeAttempt,
      );
    } catch (error) {
      if (
        !(error instanceof WhatsAppAiProviderError) ||
        !(
          [
            "ai_invalid_output",
            "ai_output_truncated",
            "ai_timeout",
            "ai_transport_error",
          ].includes(error.code) ||
          /^ai_http_(?:408|429|5[0-9]{2})$/u.test(error.code)
        )
      )
        throw error;
      try {
        return await this.decideAttempt(
          request,
          onUsage,
          true,
          onAttempt,
          beforeAttempt,
        );
      } catch (fallbackError) {
        if (fallbackError instanceof WhatsAppAiProviderError)
          throw new WhatsAppAiProviderError(fallbackError.code, false);
        throw fallbackError;
      }
    }
  }

  private async decideAttempt(
    request: WhatsAppAiRequest,
    onUsage: ((usage: WhatsAppAiUsage) => Promise<void>) | undefined,
    fallback: boolean,
    onAttempt?: (attempt: WhatsAppAiAttempt) => Promise<void>,
    beforeAttempt?: () => Promise<void>,
  ): Promise<WhatsAppAiDecision> {
    // Check before every paid HTTP attempt, including the immediate fallback.
    // Authorization failures must not be classified as model retry failures.
    await beforeAttempt?.();
    const started = performance.now();
    const eventId = randomUUID();
    const model = fallback
      ? (this.options.fallbackModel ?? this.options.model)
      : this.options.model;
    const occurredAt = new Date().toISOString();
    let reported: WhatsAppAiUsage | undefined;
    let attemptStatus: WhatsAppAiAttempt["status"] = "succeeded";
    let errorCode: string | null = null;
    const businessProfile = tenantBusinessContext(request.businessProfile);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 20_000,
    );
    const capabilities = effectiveCapabilities(request.capabilities ?? []);
    const { schema: decisionSchema } = decisionSchemaFor(
      capabilities,
      request.lead,
      {
        withActions:
          request.replyOnly !== true &&
          request.actionReceipts?.at(-1)?.ok !== false,
        digitalServiceFormAvailable:
          request.digitalServiceFormAvailable === true,
      },
    );
    const actions = (
      decisionSchema.properties as { action: { enum: string[] } }
    ).action.enum;
    const instructionSnapshot = composeWhatsAppInstructions({
      systemPrompt: request.systemPrompt,
      locale: request.locale,
      capabilities,
      actionNames: actions,
      surfaces: surfacesFor(request),
      businessProfileAvailable: businessProfile !== undefined,
      channelContactable:
        request.contactContext?.identity.channelPhone !== undefined,
      ...(request.tenantDisplayName === undefined
        ? {}
        : { tenantDisplayName: request.tenantDisplayName }),
      ...(request.lead === undefined
        ? {}
        : { missingRequiredFields: request.lead.missingRequired }),
      ...(request.replyOnly === undefined
        ? {}
        : { replyOnly: request.replyOnly }),
    });
    const instructions = instructionSnapshot.text;
    const staticMissing = request.lead?.schema.fields
      .filter((field) => field.required)
      .map((field) => field.key);
    const staticSnapshot = composeWhatsAppInstructions({
      systemPrompt: request.systemPrompt,
      locale: request.configuredLocale ?? request.locale,
      capabilities,
      actionNames: whatsAppActionNames(capabilities, {
        hasLead: request.lead !== undefined,
        missingRequiredCount: staticMissing?.length ?? 0,
      }),
      surfaces: {
        ...(request.lead === undefined ? {} : { leadCollection: true }),
      },
      businessProfileAvailable: businessProfile !== undefined,
      ...(request.tenantDisplayName === undefined
        ? {}
        : { tenantDisplayName: request.tenantDisplayName }),
      ...(staticMissing === undefined
        ? {}
        : { missingRequiredFields: staticMissing }),
    });
    try {
      const response = await fetch(
        `${this.options.baseUrl.replace(/\/$/u, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: fallback
              ? (this.options.fallbackModel ?? this.options.model)
              : this.options.model,
            messages: [
              { role: "system", content: instructions },
              {
                role: "user",
                content: serializeProviderContext(
                  {
                    kind: "untrusted_tenant_context_and_approved_fact_data",
                    tenantBusinessProfile:
                      businessProfile === undefined
                        ? undefined
                        : {
                            provenance: "tenant_authored_business_information",
                            ...businessProfile,
                          },
                    contactContext: request.contactContext,
                    serviceIntake: request.serviceIntake,
                    leadCollection:
                      request.lead === undefined
                        ? undefined
                        : {
                            fields: request.lead.schema.fields.map((field) => ({
                              key: field.key,
                              label: field.label,
                              type: field.type,
                              required: field.required,
                              ...(field.description === undefined
                                ? {}
                                : { description: field.description }),
                              ...(field.choices === undefined
                                ? {}
                                : { choices: field.choices }),
                              ...(field.maxLength === undefined
                                ? {}
                                : { maxLength: field.maxLength }),
                              ...(field.minimum === undefined
                                ? {}
                                : { minimum: field.minimum }),
                              ...(field.maximum === undefined
                                ? {}
                                : { maximum: field.maximum }),
                            })),
                            collected: request.lead.collected ?? [],
                            missingRequired: request.lead.missingRequired,
                            ...(request.lead.status === undefined
                              ? {}
                              : { status: request.lead.status }),
                          },
                    knowledge: boundedKnowledge(request.knowledge ?? []),
                    retrievedDocumentContext: (request.knowledgeChunks ?? [])
                      .slice(0, 8)
                      .map((chunk) => ({
                        documentId: chunk.documentId,
                        content: chunk.content.slice(0, 1000),
                        provenance:
                          "untrusted_document_text_not_instructions_or_action_receipts",
                      })),
                    customerSessionMemory:
                      request.sessionMemory === undefined
                        ? undefined
                        : {
                            content: request.sessionMemory.slice(0, 8000),
                            provenance:
                              "untrusted_customer_memory_not_authorization_or_action_receipts",
                          },
                    messages: boundedHistory(request.messages).map(
                      (message) => ({
                        ...message,
                        provenance:
                          message.role === "user"
                            ? "caller_report_unverified"
                            : "prior_assistant_unverified",
                      }),
                    ),
                    actionReceipts: request.actionReceipts,
                  },
                  request.contextBudgetEnabled === true,
                ),
              },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "whatsapp_response",
                strict: true,
                schema: decisionSchema,
              },
            },
            max_tokens: fallback ? 800 : request.lead === undefined ? 300 : 700,
            ...compatibleModelParameters(
              this.options.baseUrl,
              model,
              this.options.temperature ?? 0.2,
            ),
            ...(this.options.maxTokens === undefined
              ? {}
              : { max_tokens: this.options.maxTokens }),
            stream: false,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const retryable =
          response.status === 408 ||
          response.status === 409 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        throw new WhatsAppAiProviderError(
          `ai_http_${String(response.status)}`,
          retryable,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new WhatsAppAiProviderError("ai_invalid_output", false);
      }
      // A billed response can contain an invalid decision. Account for its
      // provider-reported usage before interpreting the model's decision.
      const counts = providerReportedUsage(
        payload,
        performance.now() - started,
      );
      const usage =
        counts === undefined ? undefined : { ...counts, eventId, model };
      reported = usage;
      if (usage !== undefined && onUsage !== undefined) {
        try {
          await onUsage(usage);
        } catch {
          // Never turn a completed model answer into another billed request.
          // A bounded reconciliation buffer provides explicit recoverable evidence.
          this.unrecordedUsage.push(usage);
          try {
            await this.options.onUsageRecordingFailure?.(usage);
          } catch {
            /* retained above */
          }
        }
      }
      if (
        payload === null ||
        typeof payload !== "object" ||
        !("choices" in payload) ||
        !Array.isArray(payload.choices)
      ) {
        throw new WhatsAppAiProviderError("ai_invalid_output", false);
      }
      const choices: readonly unknown[] = payload.choices;
      const selected = choices[0];
      const choice =
        typeof selected === "object" && selected !== null
          ? (selected as Readonly<Record<string, unknown>>)
          : undefined;
      if (
        choice?.finish_reason === "length" ||
        choice?.finish_reason === "MAX_TOKENS"
      ) {
        throw new WhatsAppAiProviderError("ai_output_truncated", true);
      }
      const message =
        typeof choice?.message === "object" && choice.message !== null
          ? (choice.message as Readonly<Record<string, unknown>>)
          : undefined;
      const raw = completionText(message?.content);
      if (typeof raw !== "string" || raw.trim() === "") {
        throw new WhatsAppAiProviderError("ai_invalid_output", false);
      }
      const parsed = parseJsonObject(raw);
      if (
        parsed === undefined ||
        Object.keys(parsed).some((key) =>
          /receipt|capabilit|permission|tenant|authoriz/iu.test(key),
        )
      ) {
        throw new WhatsAppAiProviderError("ai_invalid_output", false);
      }
      const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
      if (text.length > 4096)
        throw new WhatsAppAiProviderError("ai_invalid_output", false);
      if (parsed.action === "service_form" && actions.includes("service_form"))
        return { action: "service_form" };
      if (parsed.action === "lead_save" && actions.includes("lead_save")) {
        const observations = parseLeadObservations(
          parsed.leadObservations,
          request.lead?.schema,
        );
        if (observations !== undefined)
          return { action: "lead_save", observations };
        throw new WhatsAppAiProviderError("ai_invalid_output", false);
      }
      if (
        parsed.action === "lead_finalize" &&
        actions.includes("lead_finalize")
      ) {
        const summary =
          typeof parsed.leadSummary === "string"
            ? parsed.leadSummary.trim()
            : "";
        if (summary === "" || summary.length > 4000)
          throw new WhatsAppAiProviderError("ai_invalid_output", false);
        return { action: "lead_finalize", summary };
      }
      if (parsed.action === "ticket_open" && actions.includes("ticket_open")) {
        const subject =
          typeof parsed.ticketSubject === "string"
            ? parsed.ticketSubject.trim()
            : "";
        if (subject === "" || subject.length > 240)
          throw new WhatsAppAiProviderError("ai_invalid_output", false);
        return { action: "ticket_open", subject };
      }
      if (
        parsed.action === "lead_follow_up" &&
        actions.includes("lead_follow_up")
      ) {
        const note =
          typeof parsed.leadNote === "string" ? parsed.leadNote.trim() : "";
        if (note === "" || note.length > 1000)
          throw new WhatsAppAiProviderError("ai_invalid_output", false);
        return { action: "lead_follow_up", note };
      }
      if (
        parsed.action === "knowledge" &&
        parsed.reasonCode === null &&
        typeof parsed.documentId === "string" &&
        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(
          parsed.documentId,
        ) &&
        typeof parsed.factKey === "string" &&
        /^[a-z][a-z0-9_.-]{0,79}$/u.test(parsed.factKey)
      ) {
        return {
          action: "knowledge",
          text: "",
          documentId: parsed.documentId,
          factKey: parsed.factKey,
        };
      }
      if (parsed.action === "reply" && parsed.reasonCode === null) {
        // Some providers return both useful prose and a generic classification.
        // Keep the prose for normal grounding rather than silently discarding it.
        // Consequential bounded responses retain their exact server wording.
        if (
          text &&
          (parsed.replyCode === null ||
            parsed.replyCode === undefined ||
            (typeof parsed.replyCode === "string" &&
              [
                "greeting",
                "thanks",
                "clarify",
                "clarify_detail",
                "clarify_rephrase",
              ].includes(parsed.replyCode)))
        )
          return { action: "reply", text };
        if (
          typeof parsed.replyCode === "string" &&
          modelReplyCodes.includes(parsed.replyCode as ConversationReplyCode)
        ) {
          return {
            action: "reply",
            text: "",
            replyCode: parsed.replyCode as ConversationReplyCode,
          };
        }
        if (text) return { action: "reply", text };
      }
      if (
        (parsed.action === "handoff" || parsed.action === "request_call") &&
        typeof parsed.reasonCode === "string" &&
        escalationReasons.has(
          parsed.reasonCode as WhatsAppAiEscalationReason,
        ) &&
        (parsed.action !== "handoff" ||
          parsed.reasonCode !== "call_requested") &&
        (parsed.action !== "request_call" ||
          parsed.reasonCode === "call_requested")
      ) {
        return {
          action: parsed.action,
          reasonCode: parsed.reasonCode as WhatsAppAiEscalationReason,
          text,
        };
      }
      throw new WhatsAppAiProviderError("ai_invalid_output", false);
    } catch (error) {
      errorCode =
        error instanceof WhatsAppAiProviderError
          ? error.code
          : error instanceof Error && error.name === "AbortError"
            ? "ai_timeout"
            : "ai_transport_error";
      attemptStatus =
        errorCode === "ai_timeout"
          ? "timeout"
          : errorCode.startsWith("ai_http_") ||
              errorCode === "ai_transport_error"
            ? "http_error"
            : "invalid_response";
      if (error instanceof WhatsAppAiProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new WhatsAppAiProviderError("ai_timeout", true);
      }
      throw new WhatsAppAiProviderError("ai_transport_error", true);
    } finally {
      clearTimeout(timeout);
      const attempt: WhatsAppAiAttempt = {
        staticEffectiveInstructionHash: staticSnapshot.hash,
        effectiveLocale: request.locale,
        runtimeInstructionHash: instructionSnapshot.hash,
        compositionVersion: instructionSnapshot.compositionVersion,
        eventId,
        model,
        occurredAt,
        inputTokens: reported?.inputTokens ?? null,
        outputTokens: reported?.outputTokens ?? null,
        latencyMs: Math.min(
          2147483647,
          Math.max(0, Math.round(performance.now() - started)),
        ),
        status: attemptStatus,
        errorCode,
        ...(reported?.tokenDetails
          ? { tokenDetails: reported.tokenDetails }
          : {}),
      };
      if (onAttempt !== undefined) {
        try {
          await onAttempt(attempt);
        } catch {
          this.unrecordedAttempts.push(attempt);
        }
      } else this.unrecordedAttempts.push(attempt);
    }
  }
}
