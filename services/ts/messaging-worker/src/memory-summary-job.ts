import type { MemoryTurn } from "@or-on/crm";

export interface MemorySummaryProvider {
  summarize(input: {
    readonly customerTurns: readonly MemoryTurn[];
    readonly signal: AbortSignal;
  }): Promise<string>;
}
export interface MemorySummaryWork {
  readonly requestId: string;
  readonly channel: "whatsapp" | "voice";
  readonly sessionId: string;
  readonly watermark: string;
  readonly turns: readonly MemoryTurn[];
}
export interface MemorySummaryJobPorts {
  /** Both operations run in an owned-claim transaction and recheck canonical authority. */
  load(): Promise<MemorySummaryWork>;
  persist(text: string): Promise<void>;
  fail(
    reason: "memory_summary_unavailable" | "memory_summary_failed",
  ): Promise<void>;
}

/** Background-only shadow output. It never creates facts or business receipts. */
export async function processMemorySummaryJob(
  ports: MemorySummaryJobPorts,
  provider: MemorySummaryProvider | undefined,
): Promise<void> {
  if (!provider) {
    await ports.fail("memory_summary_unavailable");
    return;
  }
  const cancellation = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = await ports.load();
    if (
      work.turns.length < 1 ||
      work.turns.length > 20 ||
      work.turns.some(
        (turn) => turn.source !== "customer" || !turn.id || !turn.text,
      )
    )
      throw new TypeError("invalid canonical summary source");
    const text = await Promise.race([
      provider.summarize({
        customerTurns: work.turns,
        signal: cancellation.signal,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          cancellation.abort();
          reject(new Error("summary deadline"));
        }, 15_000);
      }),
    ]);
    if (!text.trim() || Array.from(text).length > 4000)
      throw new TypeError("invalid shadow summary output");
    await ports.persist(text);
  } catch {
    await ports.fail("memory_summary_failed");
  } finally {
    cancellation.abort();
    if (timer) clearTimeout(timer);
  }
}
