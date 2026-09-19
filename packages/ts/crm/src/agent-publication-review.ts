/**
 * What a proposed agent version will actually be able to do, for the publish
 * screen.
 *
 * Two kinds of finding, kept apart on purpose:
 *  - Enabled actions and blocking problems are decided deterministically from
 *    the capability list and the pinned field schema. They are facts.
 *  - Prompt warnings come from reading the prose for promises no enabled
 *    action can keep. They are hints for the operator, not a proof: a prompt
 *    can phrase a promise in ways no pattern anticipates, and silence here
 *    does not mean every sentence of the prompt is executable.
 */

import {
  effectiveCapabilities,
  hasCapability,
  type AgentCapability,
} from "./agent-capabilities.js";
import { leadCaptureContract } from "./lead-capture-contract.generated.js";
import type { LeadFieldDefinition } from "./lead-schema.js";

export interface AgentActionDescription {
  readonly name: string;
  readonly capability: AgentCapability;
  readonly description: string;
  readonly mutating: boolean;
}

export type AgentPromptPromise =
  "lead_saving" | "booking" | "payment" | "outbound_message";

export interface AgentPublicationReview {
  readonly enabledActions: readonly AgentActionDescription[];
  readonly leadFields: readonly Pick<
    LeadFieldDefinition,
    "key" | "label" | "type" | "required"
  >[];
  /** Deterministic reasons the version cannot run as configured. */
  readonly blocking: readonly (
    "lead_schema_missing" | "lead_schema_without_capability"
  )[];
  /** Promises in the prose that no enabled action can keep. Hints, not proof. */
  readonly promptWarnings: readonly AgentPromptPromise[];
}

/**
 * Patterns for promises a prompt might make. Deliberately few and specific:
 * each one names something this platform either grants through a capability
 * (saving lead details) or has no action for at all (bookings, payments,
 * outbound messages sent by the agent itself).
 */
const promisePatterns: Readonly<Record<AgentPromptPromise, RegExp>> = {
  lead_saving:
    /\b(?:save|record|capture|log)\b[^.!?\n]{0,40}\b(?:lead|details?|information|answers?|requirements?)\b|(?:לשמור|שמור|לרשום|רשום|תעד|לתעד)[^.!?\n]{0,30}(?:פרטים|מידע|ליד|תשובות|דרישות)/iu,
  booking:
    /\b(?:book|schedule|reserve)\b[^.!?\n]{0,30}\b(?:appointment|meeting|demo|call|visit|slot)\b|\bcalendar\b|(?:לקבוע|קבע|לתאם|תאם|להזמין)[^.!?\n]{0,30}(?:פגישה|תור|הדגמה|שיחה|ביקור)/iu,
  payment:
    /\b(?:charge|take\s+payment|process\s+(?:a\s+)?payment|issue\s+(?:an?\s+)?(?:invoice|refund))\b|(?:לחייב|לגבות|לבצע\s+תשלום|להפיק\s+חשבונית|לזכות)/iu,
  outbound_message:
    /\b(?:send|text|message|email)\b[^.!?\n]{0,20}\b(?:the\s+customer|them|a\s+(?:link|summary|quote|confirmation))\b|(?:לשלוח|אשלח|שלח)[^.!?\n]{0,20}(?:קישור|סיכום|הצעת\s+מחיר|אישור|הודעה)/iu,
};

/** Not a model tool: what an escalation does for a ticketing agent. */
const ticketOnEscalation: AgentActionDescription = {
  name: "ticket_on_escalation",
  capability: "ticket.open",
  description:
    "When the conversation is escalated to a person, open or update the customer's support ticket.",
  mutating: true,
};

export function reviewAgentPublication(input: {
  readonly prompt: string;
  readonly capabilities: readonly AgentCapability[];
  readonly leadFields: readonly LeadFieldDefinition[] | null;
  /** A version published before capabilities keeps its escalation tickets. */
  readonly implicitTicketing?: boolean;
}): AgentPublicationReview {
  const granted = effectiveCapabilities(input.capabilities);
  const collectsLeads = hasCapability(granted, "lead.read");
  const enabledActions: AgentActionDescription[] =
    leadCaptureContract.tools.definitions
      .filter((definition) => hasCapability(granted, definition.capability))
      .map((definition) => ({
        name: definition.name,
        capability: definition.capability,
        description: definition.description,
        mutating: definition.mutating,
      }));
  if (hasCapability(granted, "ticket.open") || input.implicitTicketing === true)
    enabledActions.push(ticketOnEscalation);
  const blocking: AgentPublicationReview["blocking"][number][] = [];
  if (collectsLeads && input.leadFields === null)
    blocking.push("lead_schema_missing");
  if (!collectsLeads && input.leadFields !== null)
    blocking.push("lead_schema_without_capability");
  const promptWarnings = (
    Object.entries(promisePatterns) as [AgentPromptPromise, RegExp][]
  )
    .filter(([promise, pattern]) => {
      if (!pattern.test(input.prompt)) return false;
      // Saving is the one promise a capability can make true.
      return promise !== "lead_saving" || !hasCapability(granted, "lead.write");
    })
    .map(([promise]) => promise);
  return {
    enabledActions,
    leadFields: (input.leadFields ?? []).map(
      ({ key, label, type, required }) => ({
        key,
        label,
        type,
        required,
      }),
    ),
    blocking,
    promptWarnings,
  };
}
