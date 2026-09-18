/**
 * The typed contract a post-call analysis has to satisfy before it is stored.
 *
 * A paragraph of prose from a model is not evidence, and the three statements
 *
 *   "the agent asked the customer to restart the router"
 *   "the customer said the router was restarted"
 *   "the internet came back afterwards"
 *
 * are three different claims with three different sources. Flattening them into
 * "resolved the connectivity problem" is how a support system starts reporting
 * successes it cannot show you. So every claim here carries a source, model
 * interpretation is kept in fields of its own, and anything whose source does
 * not resolve against real evidence is dropped before persistence rather than
 * argued with.
 *
 * The hardest rule is the one about completed actions: only an authoritative
 * application receipt — a queued message, a handoff, a service case the
 * platform itself created — may establish that something was actually done.
 * "The agent said a technician would be booked" is a commitment, not a booking,
 * and no amount of model confidence promotes it.
 *
 * Pure and dependency-free on purpose: the rules are the valuable part and they
 * are worth testing without a database or a provider.
 */

export const POST_CALL_ANALYSIS_SCHEMA_VERSION = "1.0";

export type AnalysisSourceKind =
  "transcript_turn" | "whatsapp_message" | "action_receipt" | "operator_note";

export interface AnalysisSource {
  readonly kind: AnalysisSourceKind;
  /** A transcript turn index, a message id, or a receipt id. */
  readonly reference: string;
}

export interface SourcedStatement {
  readonly statement: string;
  readonly sources: readonly AnalysisSource[];
}

export interface AttemptedAction {
  readonly action: string;
  /** What the evidence supports, which is rarely "it worked". */
  readonly result: "succeeded" | "failed" | "unknown";
  readonly sources: readonly AnalysisSource[];
}

export interface CompletedAction {
  readonly action: string;
  /** Must match a receipt the platform issued; model-named ones are dropped. */
  readonly receipt: AnalysisSource;
}

export type AnalysisResolution =
  | "resolved"
  | "proposed_fix_awaiting_confirmation"
  | "unresolved"
  | "needs_human"
  | "cancelled"
  | "duplicate";

export type AnalysisConfirmationSource =
  | "customer_call"
  | "customer_whatsapp"
  | "operator"
  | "authoritative_system"
  | "none";

export interface PostCallAnalysis {
  readonly schemaVersion: typeof POST_CALL_ANALYSIS_SCHEMA_VERSION;
  readonly issue: string;
  readonly customerFacts: readonly SourcedStatement[];
  readonly priorContext: readonly SourcedStatement[];
  readonly actionsAttempted: readonly AttemptedAction[];
  readonly actionsCompleted: readonly CompletedAction[];
  readonly unresolvedItems: readonly string[];
  readonly commitments: readonly SourcedStatement[];
  readonly nextAction: string | null;
  readonly recommendedOwner: "ai" | "human_support" | "field_service" | null;
  /** Only when the customer said something that shows it; otherwise null. */
  readonly sentiment: "positive" | "neutral" | "negative" | null;
  readonly sentimentSources: readonly AnalysisSource[];
  readonly resolution: AnalysisResolution;
  readonly resolutionConfirmationSource: AnalysisConfirmationSource;
  /**
   * Confidence in the CLASSIFICATION, not in the customer being happy. "I am
   * sure this call ended unresolved" is a high-confidence bad outcome.
   */
  readonly classificationConfidence: "high" | "medium" | "low";
  readonly classificationSources: readonly AnalysisSource[];
}

/** What the worker loaded from the database and will accept as a source. */
export interface AuthoritativeEvidence {
  /** Number of turns the verified transcript actually contains. */
  readonly transcriptTurnCount: number;
  readonly whatsAppMessageIds: readonly string[];
  /** Receipts the PLATFORM issued: handoffs, queued messages, service cases. */
  readonly actionReceiptIds: readonly string[];
  readonly operatorNoteIds: readonly string[];
}

const SOURCE_KINDS: readonly AnalysisSourceKind[] = [
  "transcript_turn",
  "whatsapp_message",
  "action_receipt",
  "operator_note",
];
const RESOLUTIONS: readonly AnalysisResolution[] = [
  "resolved",
  "proposed_fix_awaiting_confirmation",
  "unresolved",
  "needs_human",
  "cancelled",
  "duplicate",
];
const CONFIRMATION_SOURCES: readonly AnalysisConfirmationSource[] = [
  "customer_call",
  "customer_whatsapp",
  "operator",
  "authoritative_system",
  "none",
];

const MAX_STATEMENT = 400;
const MAX_ITEMS = 12;
const MAX_SOURCES = 6;

/**
 * The strict JSON schema handed to the provider.
 *
 * Every property is required and nullable rather than optional: providers that
 * support strict structured output enforce the full shape, and a missing key is
 * then impossible rather than something the parser has to tolerate.
 */
export const postCallAnalysisJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "issue",
    "customerFacts",
    "priorContext",
    "actionsAttempted",
    "actionsCompleted",
    "unresolvedItems",
    "commitments",
    "nextAction",
    "recommendedOwner",
    "sentiment",
    "sentimentSources",
    "resolution",
    "resolutionConfirmationSource",
    "classificationConfidence",
    "classificationSources",
  ],
  properties: {
    issue: { type: "string" },
    customerFacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "sources"],
        properties: {
          statement: { type: "string" },
          sources: { $ref: "#/$defs/sources" },
        },
      },
    },
    priorContext: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "sources"],
        properties: {
          statement: { type: "string" },
          sources: { $ref: "#/$defs/sources" },
        },
      },
    },
    actionsAttempted: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "result", "sources"],
        properties: {
          action: { type: "string" },
          result: { type: "string", enum: ["succeeded", "failed", "unknown"] },
          sources: { $ref: "#/$defs/sources" },
        },
      },
    },
    actionsCompleted: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "receipt"],
        properties: {
          action: { type: "string" },
          receipt: { $ref: "#/$defs/source" },
        },
      },
    },
    unresolvedItems: { type: "array", items: { type: "string" } },
    commitments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "sources"],
        properties: {
          statement: { type: "string" },
          sources: { $ref: "#/$defs/sources" },
        },
      },
    },
    nextAction: { type: ["string", "null"] },
    recommendedOwner: {
      type: ["string", "null"],
      enum: ["ai", "human_support", "field_service", null],
    },
    sentiment: {
      type: ["string", "null"],
      enum: ["positive", "neutral", "negative", null],
    },
    sentimentSources: { $ref: "#/$defs/sources" },
    resolution: { type: "string", enum: [...RESOLUTIONS] },
    resolutionConfirmationSource: {
      type: "string",
      enum: [...CONFIRMATION_SOURCES],
    },
    classificationConfidence: {
      type: "string",
      enum: ["high", "medium", "low"],
    },
    classificationSources: { $ref: "#/$defs/sources" },
  },
  $defs: {
    source: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reference"],
      properties: {
        kind: { type: "string", enum: [...SOURCE_KINDS] },
        reference: { type: "string" },
      },
    },
    sources: { type: "array", items: { $ref: "#/$defs/source" } },
  },
} as const;

function text(value: unknown, maximum = MAX_STATEMENT): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return undefined;
  return normalized.slice(0, maximum);
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * Keep a source only if the thing it points at exists.
 *
 * A transcript turn index beyond the verified turn count, a WhatsApp message id
 * from another conversation and an invented receipt are all the same failure:
 * a citation to something the platform cannot produce.
 */
function resolveSource(
  value: unknown,
  evidence: AuthoritativeEvidence,
): AnalysisSource | undefined {
  const source = record(value);
  const kind = source?.kind;
  const reference = text(source?.reference, 128);
  if (
    reference === undefined ||
    typeof kind !== "string" ||
    !SOURCE_KINDS.includes(kind as AnalysisSourceKind)
  )
    return undefined;
  if (kind === "transcript_turn") {
    if (!/^\d{1,6}$/u.test(reference)) return undefined;
    const index = Number(reference);
    if (index < 1 || index > evidence.transcriptTurnCount) return undefined;
    return { kind, reference };
  }
  const allowed =
    kind === "whatsapp_message"
      ? evidence.whatsAppMessageIds
      : kind === "action_receipt"
        ? evidence.actionReceiptIds
        : evidence.operatorNoteIds;
  return allowed.includes(reference)
    ? { kind: kind as AnalysisSourceKind, reference }
    : undefined;
}

function resolveSources(
  value: unknown,
  evidence: AuthoritativeEvidence,
): readonly AnalysisSource[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_SOURCES)
    .map((item) => resolveSource(item, evidence))
    .filter((item): item is AnalysisSource => item !== undefined);
}

function sourcedStatements(
  value: unknown,
  evidence: AuthoritativeEvidence,
): readonly SourcedStatement[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_ITEMS)
    .map((item) => {
      const entry = record(item);
      const statement = text(entry?.statement);
      const sources = resolveSources(entry?.sources, evidence);
      // An unsourced claim is an assertion, and this record does not carry
      // assertions. Dropping it costs a sentence; keeping it costs the
      // distinction the whole contract exists to hold.
      return statement === undefined || sources.length === 0
        ? undefined
        : { statement, sources };
    })
    .filter((item): item is SourcedStatement => item !== undefined);
}

export class PostCallAnalysisError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "PostCallAnalysisError";
  }
}

/**
 * Validate a provider's structured output against the evidence that exists.
 *
 * Unsupported claims are removed rather than rejecting the whole analysis: a
 * model that cites four real turns and invents a fifth has still produced three
 * useful paragraphs, and the surviving fields are exactly the ones an operator
 * can check. What cannot be salvaged is the classification — an issue summary
 * or a resolution the schema does not recognise fails the analysis outright.
 */
export function parsePostCallAnalysis(
  value: unknown,
  evidence: AuthoritativeEvidence,
): PostCallAnalysis {
  const payload = record(value);
  if (payload === undefined)
    throw new PostCallAnalysisError("analysis_not_an_object");
  const issue = text(payload.issue);
  if (issue === undefined) throw new PostCallAnalysisError("analysis_no_issue");
  const resolution = payload.resolution;
  if (
    typeof resolution !== "string" ||
    !RESOLUTIONS.includes(resolution as AnalysisResolution)
  )
    throw new PostCallAnalysisError("analysis_invalid_resolution");
  const confirmation = payload.resolutionConfirmationSource;
  if (
    typeof confirmation !== "string" ||
    !CONFIRMATION_SOURCES.includes(confirmation as AnalysisConfirmationSource)
  )
    throw new PostCallAnalysisError("analysis_invalid_confirmation");
  const confidence = payload.classificationConfidence;
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low")
    throw new PostCallAnalysisError("analysis_invalid_confidence");

  const attempted = Array.isArray(payload.actionsAttempted)
    ? payload.actionsAttempted
        .slice(0, MAX_ITEMS)
        .map((item) => {
          const entry = record(item);
          const action = text(entry?.action);
          const result = entry?.result;
          const sources = resolveSources(entry?.sources, evidence);
          if (
            action === undefined ||
            sources.length === 0 ||
            (result !== "succeeded" &&
              result !== "failed" &&
              result !== "unknown")
          )
            return undefined;
          return { action, result, sources };
        })
        .filter((item): item is AttemptedAction => item !== undefined)
    : [];

  // The strict one. A completed external action needs a receipt the platform
  // issued; nothing the customer or the agent SAID can put an entry here.
  const completed = Array.isArray(payload.actionsCompleted)
    ? payload.actionsCompleted
        .slice(0, MAX_ITEMS)
        .map((item) => {
          const entry = record(item);
          const action = text(entry?.action);
          const receipt = resolveSource(entry?.receipt, evidence);
          return action === undefined || receipt?.kind !== "action_receipt"
            ? undefined
            : { action, receipt };
        })
        .filter((item): item is CompletedAction => item !== undefined)
    : [];

  const sentimentSources = resolveSources(payload.sentimentSources, evidence);
  const sentiment =
    (payload.sentiment === "positive" ||
      payload.sentiment === "neutral" ||
      payload.sentiment === "negative") &&
    sentimentSources.length > 0
      ? payload.sentiment
      : null;

  return {
    schemaVersion: POST_CALL_ANALYSIS_SCHEMA_VERSION,
    issue,
    customerFacts: sourcedStatements(payload.customerFacts, evidence),
    priorContext: sourcedStatements(payload.priorContext, evidence),
    actionsAttempted: attempted,
    actionsCompleted: completed,
    unresolvedItems: Array.isArray(payload.unresolvedItems)
      ? payload.unresolvedItems
          .slice(0, MAX_ITEMS)
          .map((item) => text(item))
          .filter((item): item is string => item !== undefined)
      : [],
    commitments: sourcedStatements(payload.commitments, evidence),
    nextAction: text(payload.nextAction) ?? null,
    recommendedOwner:
      payload.recommendedOwner === "ai" ||
      payload.recommendedOwner === "human_support" ||
      payload.recommendedOwner === "field_service"
        ? payload.recommendedOwner
        : null,
    sentiment,
    sentimentSources,
    resolution: resolution as AnalysisResolution,
    resolutionConfirmationSource: confirmation as AnalysisConfirmationSource,
    classificationConfidence: confidence,
    classificationSources: resolveSources(
      payload.classificationSources,
      evidence,
    ),
  };
}

export type TicketResolutionOutcome =
  "unknown" | "unresolved" | "proposed_fix_awaiting_confirmation" | "resolved";
export type TicketConfirmationOutcome =
  "none" | "customer" | "authoritative_evidence";
export type TicketStageOutcome =
  "awaiting_customer" | "awaiting_human" | "ai_handling";

export interface ResolutionDecision {
  readonly resolution: TicketResolutionOutcome;
  readonly confirmedBy: TicketConfirmationOutcome;
  readonly stage: TicketStageOutcome;
  /** Whether a person now owns the issue. Terminal for automatic work. */
  readonly requiresHuman: boolean;
  /** A fixed code an operator can read, never model prose. */
  readonly reason: string;
  /** Whether the customer should be asked to confirm on WhatsApp. */
  readonly askCustomer: boolean;
}

export interface ResolutionInputs {
  readonly analysis: PostCallAnalysis | undefined;
  /** The dialled outcome, which is authoritative and not model-derived. */
  readonly callOutcome: string;
  readonly transcriptState:
    "pending" | "valid" | "partial" | "empty" | "missing" | "failed";
}

/**
 * Turn an analysis into a ticket outcome, conservatively.
 *
 * The rules are deliberately boring, because every interesting rule here is a
 * way to report a resolution that did not happen:
 *
 *  - A call that was never answered resolves nothing, whatever the model says.
 *  - A call that disconnected cannot carry a confirmation, because the customer
 *    was not there to give one.
 *  - `resolved` needs the customer to have confirmed it IN the call, cited to a
 *    real transcript turn, with the classification held confidently.
 *  - Everything uncertain lands on the safer state.
 *
 * The database enforces the last line of this independently: `resolved` without
 * a confirmation source is rejected there too.
 */
export function decideTicketResolution(
  inputs: ResolutionInputs,
): ResolutionDecision {
  if (inputs.callOutcome !== "answered")
    return {
      resolution: "unresolved",
      confirmedBy: "none",
      stage: "awaiting_human",
      requiresHuman: false,
      reason: `call_outcome_${inputs.callOutcome}`,
      askCustomer: false,
    };
  const analysis = inputs.analysis;
  if (analysis === undefined)
    return {
      resolution: "unresolved",
      confirmedBy: "none",
      stage: "awaiting_human",
      requiresHuman: false,
      reason: "analysis_unavailable",
      askCustomer: false,
    };
  if (analysis.resolution === "needs_human")
    return {
      resolution: "unresolved",
      confirmedBy: "none",
      stage: "awaiting_human",
      requiresHuman: true,
      reason: "customer_needs_a_person",
      askCustomer: false,
    };
  if (
    analysis.resolution === "cancelled" ||
    analysis.resolution === "duplicate"
  )
    return {
      resolution: "unresolved",
      confirmedBy: "none",
      stage: "awaiting_human",
      requiresHuman: true,
      // Cancelling or merging an issue changes what a tenant is measured on, so
      // it is an operator's decision recorded here rather than taken here.
      reason: `analysis_${analysis.resolution}_needs_review`,
      askCustomer: false,
    };
  if (analysis.resolution === "resolved") {
    const confirmedInCall =
      analysis.resolutionConfirmationSource === "customer_call" &&
      analysis.classificationSources.some(
        (source) => source.kind === "transcript_turn",
      ) &&
      analysis.classificationConfidence === "high" &&
      (inputs.transcriptState === "valid" ||
        inputs.transcriptState === "partial");
    if (confirmedInCall)
      return {
        resolution: "resolved",
        confirmedBy: "customer",
        // Still open, and still asking. A confirmation heard once on a call is
        // worth acting on and is not worth closing the issue behind the
        // customer's back.
        stage: "awaiting_customer",
        requiresHuman: false,
        reason: "customer_confirmed_on_the_call",
        askCustomer: true,
      };
    const bySystem =
      analysis.resolutionConfirmationSource === "authoritative_system" &&
      analysis.actionsCompleted.length > 0;
    if (bySystem)
      return {
        resolution: "resolved",
        confirmedBy: "authoritative_evidence",
        stage: "awaiting_customer",
        requiresHuman: false,
        reason: "authoritative_receipt_completed_the_request",
        askCustomer: true,
      };
    // The model called it resolved and could not show why. That is exactly the
    // case this whole module exists to catch.
    return {
      resolution: "proposed_fix_awaiting_confirmation",
      confirmedBy: "none",
      stage: "awaiting_customer",
      requiresHuman: false,
      reason: "resolution_claimed_without_evidence",
      askCustomer: true,
    };
  }
  if (analysis.resolution === "proposed_fix_awaiting_confirmation")
    return {
      resolution: "proposed_fix_awaiting_confirmation",
      confirmedBy: "none",
      stage: "awaiting_customer",
      requiresHuman: false,
      reason: "fix_proposed_customer_has_not_confirmed",
      askCustomer: true,
    };
  return {
    resolution: "unresolved",
    confirmedBy: "none",
    stage: "awaiting_customer",
    requiresHuman: false,
    reason: "issue_still_open_after_the_call",
    askCustomer: true,
  };
}

export type CustomerReplyIntent =
  "confirmed_resolved" | "still_broken" | "wants_human" | "unclear";

/**
 * Read a wrap-up reply without asking a model what the customer meant.
 *
 * The follow-up offers three numbered choices and names the words for each, so
 * the overwhelming majority of replies are decidable here. Anything else stays
 * `unclear` and the ticket is left exactly as it was — a customer opening a new
 * problem in the same thread must never be mistaken for an answer to the old
 * question.
 */
export function classifyCustomerReply(text_: string): CustomerReplyIntent {
  const normalized = text_
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  if (normalized.length === 0 || normalized.length > 60) return "unclear";
  if (/^1$/u.test(normalized)) return "confirmed_resolved";
  if (/^2$/u.test(normalized)) return "still_broken";
  if (/^3$/u.test(normalized)) return "wants_human";
  // A person is asked for first: "still broken, get me a human" is a handoff,
  // not a fault report, and treating it as one loses the request.
  //
  // The Hebrew alternatives carry an optional one-letter prefix, because
  // "לנציג" is the form people actually type and a plain word boundary misses
  // every inflected one of them.
  if (
    /(?:^|\s)(?:[להומשבכ]?(?:נציג|נציגה)|בן אדם|אדם אמיתי|human|agent|representative|person)(?:\s|$)/u.test(
      normalized,
    )
  )
    return "wants_human";
  if (
    /(?:^|\s)(?:לא עובד|עדיין לא|עדיין תקול|עדיין יש תקלה|עדיין לא עובד|still broken|still not working|not working|not fixed|no)(?:\s|$)/u.test(
      normalized,
    )
  )
    return "still_broken";
  if (
    /(?:^|\s)(?:נפתר|נפתרה|עובד|עכשיו עובד|הכל תקין|תקין|solved|resolved|fixed|working|it works|all good|yes)(?:\s|$)/u.test(
      normalized,
    )
  )
    return "confirmed_resolved";
  return "unclear";
}
