/** Validated, credential-free configuration stored in immutable agent versions. */
export interface AgentQualityConfiguration {
  readonly schemaVersion: "1.0";
  readonly language: "he" | "en";
  readonly agentGrammar: "feminine" | "masculine" | "neutral";
  readonly callerAddressDefault:
    "unknown" | "feminine" | "masculine" | "neutral";
  readonly speakingStyle: "concise" | "balanced" | "detailed";
  readonly speakingPace: number;
  readonly voiceId: string;
  readonly sttVocabulary: readonly string[];
  readonly pronunciationDictionary: readonly PronunciationEntry[];
  readonly budgets: {
    readonly maxResponseTokens: number;
    readonly maxSessionSeconds: number;
  };
  readonly fallbackBehavior: "clarify" | "handoff";
}

export interface PronunciationEntry {
  readonly original: string;
  readonly spoken: string;
  readonly language: "he" | "en";
  readonly context: string;
  readonly testCases: readonly string[];
}

export const defaultAgentQuality: AgentQualityConfiguration = {
  schemaVersion: "1.0",
  language: "he",
  agentGrammar: "feminine",
  callerAddressDefault: "unknown",
  speakingStyle: "concise",
  speakingPace: 1,
  voiceId: "",
  sttVocabulary: [],
  pronunciationDictionary: [],
  budgets: { maxResponseTokens: 256, maxSessionSeconds: 900 },
  fallbackBehavior: "clarify",
};

export function qualityObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("configuration must be an object");
  return value as Record<string, unknown>;
}

export function qualityText(
  value: unknown,
  label: string,
  max: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    (!allowEmpty && !value.trim()) ||
    hasControlCharacters(value, true) ||
    value.includes("<") ||
    value.includes(">")
  )
    throw new TypeError(`${label} is invalid`);
  return value.trim();
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new TypeError(`${label} is invalid`);
  return value as T;
}

function boundedNumber(
  value: unknown,
  min: number,
  max: number,
  label: string,
  integer = true,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value)) ||
    value < min ||
    value > max
  )
    throw new TypeError(`${label} is out of range`);
  return value;
}

function textList(
  value: unknown,
  label: string,
  maxItems: number,
  maxLength: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems)
    throw new TypeError(`${label} is too large`);
  return [...new Set(value.map((item) => qualityText(item, label, maxLength)))];
}

const criticalPronunciation =
  /(?:^|[^\p{L}\p{N}_])(?:[ובכלמשה]{0,2})?(?:לא|אל|אין|בלי|אסור|מותר|כן|אתה|את|לך|שלך|זכר|נקבה|אושר|אישר|שולם|שילמתי|נשלח|נקבע|בוצע|הנחה|מחיר|שקלים|שקל|אגורות|אחוז|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|אפס|אחד|אחת|שניים|שתיים|שלוש|שלושה|ארבע|ארבעה|חמש|חמישה|שש|שישה|שבע|שבעה|שמונה|תשע|תשעה|עשר|עשרה|חמישים|מאה|אלף|no|not|never|without|approved|paid|sent|booked|confirmed|discount|price|male|female|neutral|he|she|you)(?:$|[^\p{L}\p{N}_])/iu;
const unpointed = (value: string) =>
  value.normalize("NFD").replace(/\p{M}/gu, "");
function hasControlCharacters(value: string, allowLineBreaks = false): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      ((code < 32 || /\p{C}/u.test(character)) &&
        !(allowLineBreaks && "\t\n\r".includes(character))) ||
      code === 127
    )
      return true;
  }
  return false;
}
const speechMarkup = (value: string) =>
  hasControlCharacters(value) ||
  ["[", "]", "{", "}", "<", ">"].some((token) => value.includes(token));

export function parseAgentQuality(value: unknown): AgentQualityConfiguration {
  const row = qualityObject(value);
  if (row.schemaVersion !== "1.0")
    throw new TypeError("unsupported quality schema version");
  const budget = qualityObject(row.budgets);
  if (
    !Array.isArray(row.pronunciationDictionary) ||
    row.pronunciationDictionary.length > 64
  )
    throw new TypeError("pronunciation dictionary is too large");
  const pronunciationDictionary = row.pronunciationDictionary.map(
    (item): PronunciationEntry => {
      const entry = qualityObject(item);
      const original = qualityText(entry.original, "original spelling", 80);
      const spoken = qualityText(entry.spoken, "spoken form", 80);
      const context = qualityText(
        entry.context,
        "pronunciation context",
        120,
        true,
      );
      const testCases = textList(
        entry.testCases,
        "pronunciation test cases",
        8,
        240,
      );
      // Dictionary substitutions are for names/words. Critical numeric and negative
      // expressions must go through the dedicated semantic-preserving normalizer.
      if (
        /[\p{N}%₪$€£]/u.test(original + spoken) ||
        criticalPronunciation.test(unpointed(original + " " + spoken))
      )
        throw new TypeError(
          "pronunciation entries cannot replace numbers, money, or negation",
        );
      if (/[א-ת]/u.test(original) && unpointed(original) !== unpointed(spoken))
        throw new TypeError("Hebrew pronunciation may change vowel marks only");
      if (
        speechMarkup(original + spoken + context) ||
        testCases.some(speechMarkup)
      )
        throw new TypeError("pronunciation entries must contain plain text");
      return {
        original,
        spoken,
        language: oneOf(entry.language, ["he", "en"], "pronunciation language"),
        context,
        testCases,
      };
    },
  );
  if (
    new Set(
      pronunciationDictionary.map(
        (entry) =>
          `${entry.language}:${entry.original.toLowerCase()}:${entry.context.toLowerCase()}`,
      ),
    ).size !== pronunciationDictionary.length
  )
    throw new TypeError("pronunciation dictionary has duplicate entries");
  const sttVocabulary = textList(row.sttVocabulary, "STT vocabulary", 64, 80);
  if (sttVocabulary.some(speechMarkup))
    throw new TypeError("STT vocabulary must contain plain terms");
  if (sttVocabulary.reduce((sum, term) => sum + term.length, 0) > 2048)
    throw new TypeError("STT vocabulary is too large");
  return {
    schemaVersion: "1.0",
    language: oneOf(row.language, ["he", "en"], "language"),
    agentGrammar: oneOf(
      row.agentGrammar,
      ["feminine", "masculine", "neutral"],
      "agent grammar",
    ),
    callerAddressDefault: oneOf(
      row.callerAddressDefault,
      ["unknown", "feminine", "masculine", "neutral"],
      "caller address default",
    ),
    speakingStyle: oneOf(
      row.speakingStyle,
      ["concise", "balanced", "detailed"],
      "speaking style",
    ),
    speakingPace: boundedNumber(
      row.speakingPace,
      0.75,
      1.25,
      "speaking pace",
      false,
    ),
    voiceId: qualityText(row.voiceId ?? "", "voice identifier", 100, true),
    sttVocabulary,
    pronunciationDictionary,
    budgets: {
      maxResponseTokens: boundedNumber(
        budget.maxResponseTokens,
        64,
        2048,
        "response token budget",
      ),
      maxSessionSeconds: boundedNumber(
        budget.maxSessionSeconds,
        60,
        3600,
        "session duration budget",
      ),
    },
    fallbackBehavior: oneOf(
      row.fallbackBehavior,
      ["clarify", "handoff"],
      "fallback behavior",
    ),
  };
}

export function parseKnowledgeSourceIds(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 40 ||
    value.some(
      (id) =>
        typeof id !== "string" ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(id),
    )
  )
    throw new TypeError("knowledge source selection is invalid");
  return [...new Set(value as string[])];
}

export function qualityId(value: unknown): string {
  const id = parseKnowledgeSourceIds([value])[0];
  if (id === undefined) throw new TypeError("quality identifier is required");
  return id;
}
