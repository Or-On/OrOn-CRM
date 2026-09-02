export interface ReplyDraft {
  readonly provider: "simulator" | "meta";
  readonly kind: "text" | "template";
  readonly text: string;
  readonly templateName: string;
  readonly language: string;
  readonly parameters: string;
}

export const emptyReply: ReplyDraft = {
  provider: "simulator",
  kind: "text",
  text: "",
  templateName: "",
  language: "",
  parameters: "",
};

/** Ephemeral per-workspace state. Never logs/persists message content or secrets. */
export class ReplyIntentKeys {
  private readonly keys = new Map<string, string>();

  get(
    conversationId: string,
    senderId: string | undefined,
    draft: ReplyDraft,
  ): string {
    const intent = JSON.stringify([conversationId, senderId, draft]);
    const existing = this.keys.get(intent);
    if (existing) return existing;
    const key = crypto.randomUUID();
    this.keys.set(intent, key);
    return key;
  }

  complete(
    conversationId: string,
    senderId: string | undefined,
    draft: ReplyDraft,
  ): void {
    this.keys.delete(JSON.stringify([conversationId, senderId, draft]));
  }
}

export function templateParameters(source: string): readonly string[] {
  if (source.trim() === "") return [];
  const values = source.split("|").map((value) => value.trim());
  if (values.some((value) => value === ""))
    throw new Error(
      "Fill every template parameter in order; empty positions are not allowed.",
    );
  return values;
}
