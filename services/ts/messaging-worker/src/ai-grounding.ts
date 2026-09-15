import { createHash } from "node:crypto";
import { explicitWhatsAppCallbackIntent } from "@or-on/crm";

import type { WhatsAppAiDecision } from "./ai-provider.js";

/** Authenticated repository projection; never construct this from model output. */
export interface EligibleKnowledgeFact {
  readonly sourceId: string;
  readonly documentId: string;
  readonly version: number;
  readonly factKey: string;
  readonly value: string;
}

export const conversationReplyCodes = [
  "greeting",
  "thanks",
  "clarify",
  "callback_confirmation",
  "unverified_claim",
  "knowledge_unavailable",
] as const;
export type ConversationReplyCode = (typeof conversationReplyCodes)[number];

export interface GroundedReply {
  readonly text: string;
  readonly evidence:
    | {
        readonly kind: "conversation";
        readonly code: ConversationReplyCode | "generated";
      }
    | {
        readonly kind: "knowledge";
        readonly sourceId: string;
        readonly documentId: string;
        readonly version: number;
        readonly factKey: string;
        readonly valueSha256: string;
      };
}

const replies: Readonly<
  Record<ConversationReplyCode, readonly [string, string]>
> = {
  greeting: ["שלום, במה אפשר לעזור?", "Hello, how can I help?"],
  thanks: ["בשמחה.", "You're welcome."],
  clarify: ["באיזה נושא נדרשת עזרה?", "What would you like help with?"],
  callback_confirmation: [
    'כדי לבקש שיחה, נא לשלוח בהודעה נפרדת: "תתקשרו אליי עכשיו".',
    'To request a call, please reply in a separate message: "Please call me now."',
  ],
  unverified_claim: [
    "הבנתי את הפרטים שמסרת. אין לי כרגע אישור מאומת לכך. האם לבקש בדיקה של נציג?",
    "I understand what you reported. I do not currently have verification of that. Would you like an operator to review it?",
  ],
  knowledge_unavailable: [
    "המידע המאושר הזמין לי לא מספיק כדי להשיב בוודאות. האם לבקש בדיקה של נציג?",
    "The approved information available to me is insufficient to answer with certainty. Would you like an operator to review it?",
  ],
};

function localized(locale: string, values: readonly [string, string]): string {
  return values[locale.toLowerCase().startsWith("he") ? 0 : 1];
}

export function conversationalReply(
  code: ConversationReplyCode,
  locale: string,
): GroundedReply {
  return {
    text: localized(locale, replies[code]),
    evidence: { kind: "conversation", code },
  };
}

export function factDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Defense in depth for approved FAQ text, not a semantic security guarantee. */
export function safeKnowledgeStatement(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1200 &&
    !/[\p{Cc}\p{Cf}<>`]/u.test(value) &&
    !/(?:system|developer|assistant|tool)\s*:|ignore.{0,40}(?:instructions|rules)|override|receipt|התעל[םמי].{0,40}(?:הוראות|כללים)|הוראות\s*(?:מערכת|מפתח)|אישור\s*כלי/iu.test(
      value,
    ) &&
    !/\b(?:booked|refunded|delivered|connected|verified|scheduled|charged|paid|updated|sent|approved)\b|(?:קבעתי|תיאמתי|שלחתי|פתחתי|עדכנתי|זיכיתי|אימתתי|חיברתי|בוצע|נשלח|אושר|שולם|נקבע|נמסר)/iu.test(
      value,
    )
  );
}

/**
 * Allow the model to ask natural investigative questions while retaining a
 * deterministic boundary around consequential claims.  Business facts still
 * have to travel through the approved-knowledge branch above.
 */
export function safeConversationalReply(value: string): boolean {
  const text = value.trim();
  return (
    text.length > 0 &&
    text.length <= 1000 &&
    !/[\p{Cc}\p{Cf}<>`]/u.test(text) &&
    !/(?:system|developer|assistant|tool)\s*:|ignore.{0,40}(?:instructions|rules)|override|prompt|json|queue|\bLLM\b|\bAI model\b/iu.test(
      text,
    ) &&
    // Combined address forms such as ספר/י sound mechanical and still fail to
    // choose a form of address. Use natural neutral Hebrew when no trusted
    // preference is available.
    !/(?:את\s*\/\s*ה|ספר\s*\/\s*י|פנה\s*\/\s*י|בחר\s*\/\s*י|לחץ\s*\/\s*י|רוצה\s*\/\s*ה|יכול\s*\/\s*ה|צריך\s*\/\s*ה|מוכן\s*\/\s*ה|מעוניין\s*\/\s*ת|מחובר\s*\/\s*ת|זמין\s*\/\s*ה)/u.test(
      text,
    ) &&
    // Prices, discounts and other numeric commercial claims must come from an
    // eligible knowledge fact rather than unconstrained model prose.
    !/(?:[$€£₪]|\b(?:USD|EUR|GBP|NIS|ILS)\b)\s*\d|\d(?:[\d,. ]{0,16})\s*(?:%|[$€£₪]|\b(?:USD|EUR|GBP|NIS|ILS)\b)/iu.test(
      text,
    ) &&
    !/\b(?:booked|refunded|delivered|connected|verified|scheduled|charged|paid|updated|sent|approved|fixed|resolved)\b|(?:קבעתי|תיאמתי|שלחתי|פתחתי|עדכנתי|זיכיתי|אימתתי|חיברתי|תוקן|נפתר|בוצע|נשלח|אישר(?:תי|ה|ו)?|אושר(?:ה)?|שולם|נקבע|נמסר)/iu.test(
      text,
    )
  );
}

/** Choose the response language from the current message, never an old turn. */
export function latestMessageLocale(
  configuredLocale: string,
  latestText: string,
): "he" | "en" {
  const hebrewWords = latestText.match(/\p{Script=Hebrew}+/gu)?.length ?? 0;
  const latinWords = latestText.match(/\p{Script=Latin}+/gu)?.length ?? 0;
  if (hebrewWords > latinWords) return "he";
  if (latinWords > hebrewWords) return "en";
  return configuredLocale.toLowerCase().startsWith("he") ? "he" : "en";
}

/** The model selects a key; the repository supplies every delivered business word. */
export function groundAiReply(
  decision: WhatsAppAiDecision,
  facts: readonly EligibleKnowledgeFact[],
  locale: string,
): GroundedReply {
  if (decision.action === "knowledge") {
    const fact = facts.find(
      (item) =>
        item.documentId === decision.documentId &&
        item.factKey === decision.factKey,
    );
    if (
      fact !== undefined &&
      safeKnowledgeStatement(fact.value) &&
      !facts.some(
        (item) => item.factKey === fact.factKey && item.value !== fact.value,
      )
    ) {
      return {
        text: fact.value,
        evidence: {
          kind: "knowledge",
          sourceId: fact.sourceId,
          documentId: fact.documentId,
          version: fact.version,
          factKey: fact.factKey,
          valueSha256: factDigest(fact.value),
        },
      };
    }
    return conversationalReply("knowledge_unavailable", locale);
  }
  if (decision.action === "reply") {
    if (decision.replyCode !== undefined)
      return conversationalReply(decision.replyCode, locale);
    if (safeConversationalReply(decision.text)) {
      return {
        text: decision.text.trim(),
        // Natural diagnostic questions must retain a distinct evidence code.
        // Treating them as the canned `clarify` reply makes the delivery-time
        // revalidation compare different text and reject every useful answer.
        evidence: { kind: "conversation", code: "generated" },
      };
    }
    return conversationalReply("knowledge_unavailable", locale);
  }
  return conversationalReply("knowledge_unavailable", locale);
}

/** Consequential callback consent is an exact accepted message, never model prose. */
export function explicitlyRequestsImmediateCall(text: string): boolean {
  return explicitWhatsAppCallbackIntent(text);
}

/** Model classification can request clarification, but never manufacture call consent. */
export function enforceStandaloneCallbackConsent(
  decision: WhatsAppAiDecision,
  explicitStandaloneConsent: boolean,
): WhatsAppAiDecision {
  return decision.action === "request_call" && !explicitStandaloneConsent
    ? {
        action: "reply",
        replyCode: "callback_confirmation",
        text: "",
      }
    : decision;
}

/** Only durable server receipts may select these acknowledgements. */
export function actionReceiptReply(
  operation: "callback" | "handoff",
  locale: string,
): string {
  return operation === "callback"
    ? localized(locale, [
        "בקשת השיחה נוספה לתור. רישום הבקשה אינו אישור לחיבור השיחה.",
        "Your call request was queued. Recording the request does not confirm a connected call.",
      ])
    : localized(locale, [
        "נפתחה בקשה לבדיקת נציג. היא עדיין ממתינה לטיפול.",
        "A request for operator review was created and is awaiting attention.",
      ]);
}
