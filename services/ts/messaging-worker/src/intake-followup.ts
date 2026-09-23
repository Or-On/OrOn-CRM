/**
 * The WhatsApp follow-up for a phone inquiry, written by the platform.
 *
 * The model never authors this message and never chooses its recipient. It
 * summarizes only what this caller reported in this call, so it discloses
 * nothing about any other record, and it passes the shared scope validator
 * before it can be queued.
 */
import { validateAgentOutput } from "@or-on/crm";

export interface IntakeFollowupPlan {
  readonly intakeId: string;
  readonly status: string;
  readonly followupStatus: string;
  readonly contactId: string;
  readonly sessionId: string | null;
  readonly conversationId: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly missingFields: readonly string[];
  readonly requestPhoto: boolean;
  readonly followUp: {
    readonly enabled?: boolean;
    readonly templateName?: string;
    readonly templateLanguage?: string;
    readonly templateParameters?: readonly string[];
  } | null;
  readonly hebrew: boolean;
  readonly reference: string | null;
  readonly caseId: string | null;
  readonly callerIdentityId: string | null;
  readonly consent: string | null;
  readonly optedOut: boolean | null;
}

const labels: Readonly<Record<string, readonly [string, string]>> = {
  customerName: ["שם מלא", "your full name"],
  chainName: ["שם הרשת", "the chain name"],
  storeName: ["שם הסניף", "the branch name"],
  serviceLocation: ["כתובת לשירות", "the service address"],
  faultDescription: ["תיאור התקלה", "a description of the fault"],
  exactFailure: ["מה בדיוק לא עובד", "what exactly is not working"],
  warrantyStatus: ["פרטי אחריות", "warranty details"],
  callbackNumber: ["מספר לחזרה", "a callback number"],
  urgency: ["עד כמה זה דחוף", "how urgent it is"],
};

function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized === "") return undefined;
  return normalized.length > maximum
    ? `${normalized.slice(0, maximum - 1)}…`
    : normalized;
}

function compose(
  plan: IntakeFollowupPlan,
  businessName: string,
  includeCustomerText: boolean,
): string {
  const he = plan.hebrew;
  const name = includeCustomerText
    ? text(plan.fields.customerName, 60)
    : undefined;
  const fault = includeCustomerText
    ? text(plan.fields.faultDescription, 300)
    : undefined;
  const place = includeCustomerText
    ? text(plan.fields.storeName ?? plan.fields.serviceAddress, 120)
    : undefined;
  const missing = plan.missingFields
    .filter((field) => field in labels)
    .map((field) => labels[field]?.[he ? 0 : 1] ?? field);
  const lines = he
    ? [
        `שלום${name === undefined ? "" : ` ${name}`},`,
        `תודה שפנית ל${businessName}. הפנייה שלך התקבלה${plan.reference === null ? "" : ` (מספר ${plan.reference})`}.`,
        ...(fault === undefined ? [] : [`סיכום: ${fault}`]),
        ...(place === undefined ? [] : [`מיקום: ${place}`]),
        ...(missing.length === 0
          ? []
          : [`כדי להשלים את הפנייה נשמח לקבל גם: ${missing.join(", ")}.`]),
        ...(plan.requestPhoto
          ? ["נשמח לקבל תמונה של התקלה בתשובה להודעה זו."]
          : []),
      ]
    : [
        `Hello${name === undefined ? "" : ` ${name}`},`,
        `Thank you for contacting ${businessName}. Your request was received${plan.reference === null ? "" : ` (reference ${plan.reference})`}.`,
        ...(fault === undefined ? [] : [`Summary: ${fault}`]),
        ...(place === undefined ? [] : [`Location: ${place}`]),
        ...(missing.length === 0
          ? []
          : [`To complete it, please also send: ${missing.join(", ")}.`]),
        ...(plan.requestPhoto
          ? ["Please reply to this message with a photo of the fault."]
          : []),
      ];
  return lines.join("\n");
}

/**
 * Render the follow-up. If anything the caller said would make the summary
 * fail the scope validator, the customer-text lines are dropped rather than
 * sending model-shaped or instruction-shaped content.
 */
export function renderIntakeFollowup(
  plan: IntakeFollowupPlan,
  businessName: string | null,
): string {
  const business =
    text(businessName, 120) ?? (plan.hebrew ? "העסק" : "the business");
  const full = compose(plan, business, true);
  if (validateAgentOutput(full).allowed) return full;
  return compose(plan, business, false);
}

/** Positional parameters for an approved template, from server data only. */
export function followupTemplateParameters(
  plan: IntakeFollowupPlan,
  businessName: string | null,
): readonly string[] {
  return (plan.followUp?.templateParameters ?? []).map((key) => {
    if (key === "customerName")
      return text(plan.fields.customerName, 60) ?? "-";
    if (key === "reference") return plan.reference ?? "-";
    if (key === "faultSummary")
      return text(plan.fields.faultDescription, 200) ?? "-";
    return text(businessName, 120) ?? "-";
  });
}

export type FollowupDelivery =
  | { readonly kind: "text" }
  | {
      readonly kind: "template";
      readonly templateName: string;
      readonly language: string;
    }
  | { readonly kind: "blocked"; readonly reason: "blocked_window" };

/** Meta allows free text only inside the customer-service window. */
export function followupDelivery(
  plan: IntakeFollowupPlan,
  provider: "meta" | "simulator",
  windowOpen: boolean,
): FollowupDelivery {
  if (provider === "simulator" || windowOpen) return { kind: "text" };
  const name = plan.followUp?.templateName;
  const language = plan.followUp?.templateLanguage;
  if (typeof name === "string" && typeof language === "string")
    return { kind: "template", templateName: name, language };
  return { kind: "blocked", reason: "blocked_window" };
}
