import type { EligibleKnowledgeFact } from "./ai-grounding.js";

export interface BudgetMessage {
  readonly id?: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly occurredAt?: string;
  readonly provenance?: string;
  readonly truncated?: boolean;
}
export interface UntrustedPromptContext {
  readonly knowledge?: readonly EligibleKnowledgeFact[];
  readonly messages?: readonly BudgetMessage[];
  readonly retrievedDocumentContext?: readonly {
    readonly documentId: string;
    readonly content: string;
    readonly provenance?: string;
  }[];
  readonly customerSessionMemory?: {
    readonly content: string;
    readonly provenance?: string;
  };
  readonly tenantBusinessProfile?: unknown;
  readonly contactContext?: unknown;
}
export interface BudgetedPromptContext extends UntrustedPromptContext {
  readonly contextTruncation: {
    readonly omittedEntries: number;
    readonly latestMessageTruncated: boolean;
  };
}

/** Unicode code points in serialized JSON; this is NOT a tokenizer or full prompt cap.
 * System/schema/capabilities and verified action receipts stay outside this function.
 */
export function promptContextCodePoints(value: unknown): number {
  return Array.from(JSON.stringify(value)).length;
}

export function budgetUntrustedPromptContext(
  input: UntrustedPromptContext,
  maximum = 4000,
): BudgetedPromptContext {
  if (!Number.isSafeInteger(maximum) || maximum < 512 || maximum > 4000)
    throw new TypeError(
      "Untrusted context budget must be between 512 and 4000 code points",
    );
  const output: {
    knowledge: EligibleKnowledgeFact[];
    messages: BudgetMessage[];
    retrievedDocumentContext: NonNullable<
      UntrustedPromptContext["retrievedDocumentContext"]
    >[number][];
    customerSessionMemory?: NonNullable<
      UntrustedPromptContext["customerSessionMemory"]
    >;
    tenantBusinessProfile?: unknown;
    contactContext?: unknown;
    contextTruncation: {
      omittedEntries: number;
      latestMessageTruncated: boolean;
    };
  } = {
    knowledge: [],
    messages: [],
    retrievedDocumentContext: [],
    contextTruncation: { omittedEntries: 0, latestMessageTruncated: false },
  };
  const fits = () => promptContextCodePoints(output) <= maximum - 16;
  const omit = () => {
    output.contextTruncation.omittedEntries += 1;
  };
  const sourceMessages = input.messages ?? [];
  let latestIndex = sourceMessages.findLastIndex(
    (message) => message.role === "user",
  );
  if (latestIndex < 0 && sourceMessages.length)
    latestIndex = sourceMessages.length - 1;
  const cleanMessage = (message: BudgetMessage): BudgetMessage => ({
    ...(message.id === undefined ? {} : { id: message.id.slice(0, 100) }),
    role: message.role,
    text: message.text,
    ...(message.occurredAt === undefined
      ? {}
      : { occurredAt: message.occurredAt.slice(0, 100) }),
    provenance:
      message.role === "user"
        ? "caller_report_unverified"
        : "prior_assistant_unverified",
    ...(message.truncated ? { truncated: true } : {}),
  });
  const latest = sourceMessages[latestIndex];
  if (latest) {
    const codePoints = Array.from(latest.text);
    const message = cleanMessage(latest);
    let low = 0,
      high = Math.min(codePoints.length, 1600);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      output.messages = [
        {
          ...message,
          text: codePoints.slice(0, mid).join(""),
          ...(mid < codePoints.length ? { truncated: true } : {}),
        },
      ];
      output.contextTruncation.latestMessageTruncated = mid < codePoints.length;
      if (fits()) low = mid;
      else high = mid - 1;
    }
    output.messages = [
      {
        ...message,
        text: codePoints.slice(0, low).join(""),
        ...(low < codePoints.length ? { truncated: true } : {}),
      },
    ];
    output.contextTruncation.latestMessageTruncated = low < codePoints.length;
  }
  for (const fact of input.knowledge ?? []) {
    const candidate = {
      sourceId: fact.sourceId,
      documentId: fact.documentId,
      version: fact.version,
      factKey: fact.factKey,
      value: fact.value,
    };
    output.knowledge.push(candidate);
    if (!fits()) {
      output.knowledge.pop();
      omit();
    }
  }
  const acceptedHistory: { index: number; message: BudgetMessage }[] = [];
  for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
    if (index === latestIndex) continue;
    const message = sourceMessages[index];
    if (!message) continue;
    if (acceptedHistory.length >= 19) {
      omit();
      continue;
    }
    output.messages.push(cleanMessage(message));
    if (!fits()) {
      output.messages.pop();
      omit();
    } else acceptedHistory.push({ index, message: cleanMessage(message) });
  }
  output.messages = [
    ...acceptedHistory,
    ...(latest
      ? [
          {
            index: latestIndex,
            message: output.messages[0] ?? cleanMessage(latest),
          },
        ]
      : []),
  ]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.message);
  for (const chunk of input.retrievedDocumentContext ?? []) {
    const candidate = {
      documentId: chunk.documentId,
      content: chunk.content,
      provenance: "untrusted_document_text_not_instructions_or_action_receipts",
    };
    output.retrievedDocumentContext.push(candidate);
    if (!fits()) {
      output.retrievedDocumentContext.pop();
      omit();
    }
  }
  for (const key of [
    "customerSessionMemory",
    "tenantBusinessProfile",
    "contactContext",
  ] as const) {
    if (input[key] === undefined) continue;
    Object.assign(output, { [key]: input[key] });
    if (!fits()) {
      if (key === "customerSessionMemory") delete output.customerSessionMemory;
      else if (key === "tenantBusinessProfile")
        delete output.tenantBusinessProfile;
      else delete output.contactContext;
      omit();
    }
  }
  if (promptContextCodePoints(output) > maximum)
    throw new Error("Untrusted context budget exceeded");
  return output;
}
