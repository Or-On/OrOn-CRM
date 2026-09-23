import { createHash } from "node:crypto";
import {
  explicitWhatsAppCallbackIntent,
  validateAgentOutput,
} from "@or-on/crm";

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
  "clarify_rephrase",
  "clarify_detail",
  "callback_confirmation",
  "unverified_claim",
  "knowledge_unavailable",
] as const;
export type ConversationReplyCode = (typeof conversationReplyCodes)[number];
export const recentReplyWindowSize = 8;

/**
 * A lead write that actually committed in this turn. It is the only thing that
 * entitles a reply to say information was recorded, and it is carried into the
 * stored evidence so delivery can check the same commit again.
 */
export interface CommittedRecord {
  readonly leadId: string;
  readonly revision: number;
  // Stored verbatim in the message's grounding metadata, which is typed as
  // plain JSON.
  readonly [field: string]: string | number;
}

export interface GroundedReply {
  readonly text: string;
  readonly evidence:
    | {
        readonly kind: "conversation";
        readonly code: ConversationReplyCode | "generated";
        readonly record?: CommittedRecord;
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
  clarify_rephrase: [
    "לא בטוח שהבנתי. אפשר לתאר את זה בדרך אחרת?",
    "I may have misunderstood. Could you describe that another way?",
  ],
  clarify_detail: [
    "אפשר לציין פרט אחד שיעזור להבין מה נדרש כרגע?",
    "Could you share one detail that would help me understand what you need now?",
  ],
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
    // The shared scope policy applies to approved knowledge too: a document
    // cannot make the agent name its model, recite prompts or leak secrets.
    validateAgentOutput(value).allowed &&
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

export interface ConversationalReplyContext {
  readonly locale?: string;
  readonly recentAssistantMessages?: readonly string[];
  readonly latestCustomerMessage?: string;
  /**
   * A lead write committed in this same turn. It admits "I saved that" and
   * nothing further: an appointment, a refund or a repair remains unsayable.
   */
  readonly committedRecord?: boolean;
}

function normalizedReply(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/\p{M}+/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/[.!?؟？！،,:;]+$/gu, "")
    .replace(
      /^(?:please\s+|(?:could|can|would)\s+you\s+(?:please\s+)?|בבקשה\s+|אפשר\s+(?:בבקשה\s+)?)/u,
      "",
    )
    .trim();
}

function normalizedComparableReply(value: string): string {
  return normalizedReply(value)
    .replace(/[.!?؟？！،,:;"'()׳״]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const defaultClarificationCodes = [
  "clarify_rephrase",
  "clarify_detail",
  "clarify",
  "knowledge_unavailable",
] as const satisfies readonly ConversationReplyCode[];

const knowledgeFallbackCodes = [
  "knowledge_unavailable",
  "clarify_rephrase",
  "clarify_detail",
  "clarify",
] as const satisfies readonly ConversationReplyCode[];

// The window contains at most eight replies. These five private variants plus
// the four canned codes above guarantee that one safe clarification remains
// unused without exposing more model-selectable reply codes.
const clarificationVariants = [
  [
    "מה הפרט החשוב ביותר שכדאי להתמקד בו כרגע?",
    "What is the most important detail to focus on right now?",
  ],
  [
    "אפשר לתאר את התסמין הנוכחי במשפט קצר אחד?",
    "Could you describe the current symptom in one short sentence?",
  ],
  [
    "מה השתנה מיד לפני שהבעיה הופיעה?",
    "What changed immediately before the issue appeared?",
  ],
  [
    "באיזה חלק של הבעיה כדאי להתמקד קודם?",
    "Which part of the issue should we address first?",
  ],
  ["אפשר לציין מה מופיע כרגע?", "Could you tell me what you see right now?"],
] as const satisfies readonly (readonly [string, string])[];

function repeatsRecentAssistant(
  value: string,
  recentAssistantMessages: readonly string[],
): boolean {
  const candidate = normalizedReply(value);
  if (candidate.length === 0) return false;
  const comparableCandidate = normalizedComparableReply(value);
  return recentAssistantMessages
    .slice(-recentReplyWindowSize)
    .some((message) => {
      const previous = normalizedReply(message);
      if (candidate === previous) return true;
      const comparablePrevious = normalizedComparableReply(message);
      // Reject verbatim recycling of a complete recent turn even when the
      // model adds a short acknowledgement or another sentence around it, or
      // drops the surrounding acknowledgement and repeats only the question.
      // Very short phrases are intentionally excluded because words such as
      // "thanks" can occur naturally in a later, otherwise distinct reply.
      const previousIsSubstantial =
        comparablePrevious.length >= 18 &&
        comparablePrevious.split(" ").length >= 4;
      const candidateIsSubstantial =
        comparableCandidate.length >= 18 &&
        comparableCandidate.split(" ").length >= 4;
      return (
        (previousIsSubstantial &&
          comparableCandidate.includes(comparablePrevious)) ||
        (candidateIsSubstantial &&
          comparablePrevious.includes(comparableCandidate))
      );
    });
}

function parrotsLatestCustomer(
  value: string,
  latestCustomerMessage: string,
): boolean {
  const stripEchoFraming = (text: string): string => {
    let framed = normalizedComparableReply(text).replace(
      /^((?:(?:כמו\s+ש?)?(?:אמרת|ציינת)|הבנתי))\s+ש(?=\p{Script=Hebrew})/u,
      "$1 ",
    );
    const prefix =
      /^(?:(?:i\s+understand|understood)(?:\s+that)?|thanks?(?:\s+you)?\s+for\s+(?:sharing|the\s+(?:detail|details|information))|that\s+sounds\s+frustrating|(?:as\s+)?you\s+(?:said|mentioned)(?:\s+that)?|הבנתי|תודה(?:\s+רבה)?\s+על\s+(?:השיתוף|ההסבר|הפרטים)|זה\s+נשמע\s+מתסכל|(?:כמו\s+ש?)?(?:אמרת|ציינת))\s+/u;
    // A model may stack a short acknowledgement and attribution before
    // repeating the customer's turn. Remove only this closed set of framing;
    // any meaning-bearing diagnosis or question remains part of the comparison.
    for (let index = 0; index < 2; index += 1) {
      const stripped = framed.replace(prefix, "");
      if (stripped === framed) break;
      framed = stripped;
    }
    return framed.replace(
      /\s+(?:is\s+that\s+right|did\s+i\s+understand(?:\s+that)?\s+correctly|correct|right|האם\s+זה\s+נכון|הבנתי\s+נכון|נכון)$/u,
      "",
    );
  };
  const tokens = (text: string): string[] =>
    text
      .split(" ")
      .filter(Boolean)
      .map((token) =>
        /^[a-z]{5,}$/u.test(token) ? token.replace(/(?:es|s)$/u, "") : token,
      );
  const candidate = tokens(stripEchoFraming(value));
  const latest = tokens(normalizedComparableReply(latestCustomerMessage));
  const leadingQuestionWords = new Set([
    "does",
    "do",
    "did",
    "is",
    "are",
    "can",
    "could",
    "would",
    "will",
    "האם",
  ]);
  while (candidate.length > 0 && leadingQuestionWords.has(candidate[0] ?? ""))
    candidate.shift();
  if (candidate.length === 0 || latest.length === 0) return false;
  const exactMatch =
    candidate.length === latest.length &&
    candidate.every((token, index) => token === latest[index]);
  if (exactMatch) return true;
  const candidateTokens = new Set(candidate);
  const latestTokens = new Set(latest);
  const smaller = Math.min(candidateTokens.size, latestTokens.size);
  if (smaller < 4) return false;
  let overlap = 0;
  for (const token of candidateTokens)
    if (latestTokens.has(token)) overlap += 1;
  return overlap / smaller >= 0.8;
}

function matchesRequestedLocale(value: string, locale: string): boolean {
  const withoutUrls = value.replace(/https?:\/\/\S+/giu, " ");
  const words =
    withoutUrls.match(/\p{Script=Hebrew}+|\p{Script=Latin}+/gu) ?? [];
  const technicalIndexes = new Set<number>();
  for (let index = 0; index < words.length;) {
    if (!/^[A-Z][\p{Script=Latin}\p{N}]*$/u.test(words[index] ?? "")) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (
      end < words.length &&
      /^[A-Z][\p{Script=Latin}\p{N}]*$/u.test(words[end] ?? "")
    )
      end += 1;
    if (end - index >= 2)
      for (let item = index; item < end; item += 1) technicalIndexes.add(item);
    index = end;
  }
  const naturalWords = words.filter(
    (word, index) =>
      !technicalIndexes.has(index) &&
      !/^(?:[A-Z]{2,}[A-Z0-9]*|[A-Za-z]*\d+[A-Za-z0-9]*)$/u.test(word),
  );
  const firstWords = (naturalWords.length > 0 ? naturalWords : words).slice(
    0,
    4,
  );
  const hebrewWords = firstWords.filter((word) =>
    /\p{Script=Hebrew}/u.test(word),
  ).length;
  const latinWords = firstWords.length - hebrewWords;
  if (locale.toLowerCase().startsWith("he"))
    return hebrewWords > 0 && hebrewWords >= latinWords;
  return latinWords > 0 && latinWords >= hebrewWords;
}

function startsInterrogativeClause(value: string): boolean {
  const text = value.trim();
  return /^(?:(?:and|also)\s+)?(?:(?:what|when|where|why|how|who|which|does|do|did|is|are|can|could|would|will)\b|please\s+(?:tell|describe|explain|share)\b)|^(?:(?:ו|וגם\s+))?(?:מה|מתי|איפה|למה|איך|מי|איזה|איזו|האם|אפשר|(?:נא|בבקשה)\s+(?:לתאר|לציין|לספר))(?!\p{L})/iu.test(
    text,
  );
}

function asksMoreThanOneQuestion(value: string): boolean {
  const withoutUrls = value.replace(/https?:\/\/\S+/giu, " ");
  if ((withoutUrls.match(/[?؟？]/gu)?.length ?? 0) > 1) return true;
  const clauses = withoutUrls.split(/[,;.!]/u);
  if (clauses.filter(startsInterrogativeClause).length > 1) return true;
  if (!startsInterrogativeClause(withoutUrls)) return false;
  return /\s+(?:(?:and|also)\s+(?:what|when|where|why|how|who|which|does|do|did|is|are|can|could|would|will)\b|(?:ו(?:מה|מתי|איפה|למה|איך|מי|איזה|איזו|האם|אפשר)|וגם\s+(?:מה|מתי|איפה|למה|איך|מי|איזה|איזו|האם|אפשר))(?!\p{L}))/iu.test(
    withoutUrls.trim(),
  );
}

function nonRepeatingClarification(
  locale: string,
  recentAssistantMessages: readonly string[],
  preferredCodes: readonly ConversationReplyCode[] = defaultClarificationCodes,
): GroundedReply {
  for (const code of preferredCodes) {
    const reply = conversationalReply(code, locale);
    if (!repeatsRecentAssistant(reply.text, recentAssistantMessages))
      return reply;
  }
  for (const values of clarificationVariants) {
    const text = localized(locale, values);
    if (!repeatsRecentAssistant(text, recentAssistantMessages))
      return { text, evidence: { kind: "conversation", code: "generated" } };
  }
  throw new TypeError("clarification fallback pool exhausted");
}

// Outcomes nothing in this conversation can produce. No receipt available on
// this channel makes them sayable, so they are refused unconditionally.
const consequentialClaimPattern =
  /\b(?:booked|refunded|delivered|connected|verified|scheduled|charged|paid|approved|fixed|resolved)\b|(?:קבעתי|תיאמתי|פתחתי|זיכיתי|אימתתי|חיברתי|תוקן|נפתר|בוצע|אישר(?:תי|ה|ו)?|אושר(?:ה)?|שולם|נקבע|נמסר)/iu;

// Claims that a lead write can back — and only a lead write. Without a
// committed receipt in this turn they are refused exactly like the rest,
// which also closes the gap where "רשמתי" was never checked at all.
const recordClaimPattern =
  /\b(?:saved|recorded|noted|logged|updated|sent)\b|(?:שמרתי|רשמתי|עדכנתי|תיעדתי|רשמנו|שלחתי|נשמר(?:ו|ה)?|נרשמ(?:ו|ה)?|נשלח)/iu;

function passesConversationalSafety(
  text: string,
  committedRecord = false,
): boolean {
  return (
    // The platform scope boundary shared with voice: no model, provider,
    // prompt, tool, secret or other-customer disclosure reaches a customer.
    validateAgentOutput(text).allowed &&
    !consequentialClaimPattern.test(text) &&
    (committedRecord || !recordClaimPattern.test(text)) &&
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
    )
  );
}

/**
 * Allow one natural, locale-correct investigative question while retaining a
 * deterministic boundary around consequential claims and repetitive output.
 */
export function safeConversationalReply(
  value: string,
  context: ConversationalReplyContext = {},
): boolean {
  const text = value.trim();
  const latestCustomerMessage = context.latestCustomerMessage?.trim();
  return (
    passesConversationalSafety(text, context.committedRecord === true) &&
    !asksMoreThanOneQuestion(text) &&
    (context.locale === undefined ||
      matchesRequestedLocale(text, context.locale)) &&
    !repeatsRecentAssistant(text, context.recentAssistantMessages ?? []) &&
    (latestCustomerMessage === undefined ||
      latestCustomerMessage.length === 0 ||
      !parrotsLatestCustomer(text, latestCustomerMessage))
  );
}

const englishLanguageSignals = new Set([
  "a",
  "an",
  "are",
  "broken",
  "can",
  "could",
  "did",
  "do",
  "does",
  "error",
  "help",
  "hello",
  "how",
  "i",
  "is",
  "issue",
  "my",
  "need",
  "no",
  "not",
  "please",
  "problem",
  "thank",
  "thanks",
  "the",
  "this",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "working",
  "would",
  "yes",
  "you",
]);

function detectedMessageLocale(latestText: string): "he" | "en" | undefined {
  // Links, email addresses and machine identifiers are evidence, not a
  // reliable language signal. In particular, a Hebrew customer pasting a
  // long support URL must not receive an English reply because the hostname
  // happens to contain more Latin tokens than the actual sentence.
  const naturalText = latestText
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/giu, " ")
    .replace(/\b(?=\S*[\p{L}\p{N}])(?=\S*\d)[\p{L}\p{N}._/-]+\b/giu, " ");
  const words =
    naturalText.match(/\p{Script=Hebrew}+|\p{Script=Latin}+/gu) ?? [];
  const containsHebrew = words.some((word) => /\p{Script=Hebrew}/u.test(word));
  const rawLatinLetters = words.reduce(
    (count, word) => count + (word.match(/\p{Script=Latin}/gu)?.length ?? 0),
    0,
  );
  // Uppercase is presentation, not proof of a machine identifier. Preserve
  // clear natural English requests such as "PLEASE HELP" while still treating
  // an isolated product acronym such as "HDMI" as language-neutral.
  if (
    !containsHebrew &&
    rawLatinLetters >= 2 &&
    words.some((word) => englishLanguageSignals.has(word.toLowerCase()))
  )
    return "en";
  const technicalIndexes = new Set<number>();
  for (let index = 0; index < words.length;) {
    if (!/^[A-Z][\p{Script=Latin}\p{N}]*$/u.test(words[index] ?? "")) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (
      end < words.length &&
      /^[A-Z][\p{Script=Latin}\p{N}]*$/u.test(words[end] ?? "")
    )
      end += 1;
    if (end - index >= 2)
      for (let item = index; item < end; item += 1) technicalIndexes.add(item);
    index = end;
  }
  const wordsWithoutTechnicalNames = words.filter(
    (word, index) =>
      !technicalIndexes.has(index) &&
      !/^(?:[A-Z]{2,}[A-Z0-9]*|[A-Za-z]*\d+[A-Za-z0-9]*)$/u.test(word),
  );
  // Do not erase an ordinary short Title Case English utterance such as
  // "Please Help". A technical-name exclusion is useful only when at least
  // two natural-language words remain to establish the surrounding grammar.
  const languageWords =
    wordsWithoutTechnicalNames.length >= 2
      ? wordsWithoutTechnicalNames
      : words.filter(
          (word) =>
            !/^(?:[A-Z]{2,}[A-Z0-9]*|[A-Za-z]*\d+[A-Za-z0-9]*)$/u.test(word),
        );
  const hebrewWords = languageWords.filter((word) =>
    /\p{Script=Hebrew}/u.test(word),
  ).length;
  const latinWords = languageWords.length - hebrewWords;
  const hebrewLetters = languageWords.reduce(
    (count, word) => count + (word.match(/\p{Script=Hebrew}/gu)?.length ?? 0),
    0,
  );
  const latinLetters = languageWords.reduce(
    (count, word) => count + (word.match(/\p{Script=Latin}/gu)?.length ?? 0),
    0,
  );
  if (hebrewWords > latinWords && hebrewLetters >= 2) return "he";
  if (latinWords > hebrewWords && latinLetters >= 2) return "en";
  return undefined;
}

/**
 * Choose the response language from the current inbound message. If that turn
 * contains only a number, URL, machine identifier, punctuation or one-letter
 * noise, retain the most recent unambiguous inbound language before falling
 * back to the agent's authored locale. Prior assistant output never decides a
 * customer's language. `recentInboundTexts` must be newest first.
 */
export function latestMessageLocale(
  configuredLocale: string,
  latestText: string,
  recentInboundTexts: readonly string[] = [],
): "he" | "en" {
  const detected = detectedMessageLocale(latestText);
  if (detected !== undefined) return detected;
  for (const previousText of recentInboundTexts.slice(0, 50)) {
    const previous = detectedMessageLocale(previousText);
    if (previous !== undefined) return previous;
  }
  return configuredLocale.toLowerCase().startsWith("he") ? "he" : "en";
}

/** The model selects a key; the repository supplies every delivered business word. */
export function groundAiReply(
  decision: WhatsAppAiDecision,
  facts: readonly EligibleKnowledgeFact[],
  locale: string,
  recentAssistantMessages: readonly string[] = [],
  latestCustomerMessage = "",
  committedRecord?: CommittedRecord,
): GroundedReply {
  const spokenContext = latestCustomerMessage.trim()
    ? [...recentAssistantMessages, latestCustomerMessage]
    : recentAssistantMessages;
  if (decision.action === "knowledge") {
    const fact = facts.find(
      (item) =>
        item.documentId === decision.documentId &&
        item.factKey === decision.factKey,
    );
    if (
      fact !== undefined &&
      safeKnowledgeStatement(fact.value) &&
      matchesRequestedLocale(fact.value, locale) &&
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
    return nonRepeatingClarification(
      locale,
      spokenContext,
      knowledgeFallbackCodes,
    );
  }
  if (decision.action === "reply") {
    if (decision.replyCode !== undefined) {
      const selected = conversationalReply(decision.replyCode, locale);
      if (
        decision.replyCode === "callback_confirmation" ||
        !repeatsRecentAssistant(selected.text, spokenContext)
      )
        return selected;
      return nonRepeatingClarification(locale, spokenContext);
    }
    if (
      safeConversationalReply(decision.text, {
        locale,
        recentAssistantMessages,
        latestCustomerMessage,
        committedRecord: committedRecord !== undefined,
      })
    ) {
      return {
        text: decision.text.trim(),
        // Natural diagnostic questions must retain a distinct evidence code.
        // Treating them as the canned `clarify` reply makes the delivery-time
        // revalidation compare different text and reject every useful answer.
        evidence: {
          kind: "conversation",
          code: "generated",
          // Carried so delivery can re-check the same commit rather than
          // re-deciding on trust.
          ...(committedRecord === undefined ? {} : { record: committedRecord }),
        },
      };
    }
    return passesConversationalSafety(
      decision.text.trim(),
      committedRecord !== undefined,
    )
      ? nonRepeatingClarification(locale, spokenContext)
      : nonRepeatingClarification(
          locale,
          spokenContext,
          knowledgeFallbackCodes,
        );
  }
  return nonRepeatingClarification(
    locale,
    spokenContext,
    knowledgeFallbackCodes,
  );
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
