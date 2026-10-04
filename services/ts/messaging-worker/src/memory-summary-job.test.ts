import { afterEach, describe, expect, it, vi } from "vitest";
import {
  processMemorySummaryJob,
  type MemorySummaryWork,
} from "./memory-summary-job.js";

const work: MemorySummaryWork = {
  requestId: "request",
  channel: "whatsapp",
  sessionId: "session",
  watermark: "message",
  turns: [{ id: "message", text: "Customer assertion", source: "customer" }],
};
afterEach(() => vi.useRealTimers());
describe("bounded background shadow summary", () => {
  it("missing trusted provider fails without loading private source text", async () => {
    const load = vi.fn(() => Promise.resolve(work)),
      persist = vi.fn(),
      fail = vi.fn();
    await processMemorySummaryJob({ load, persist, fail }, undefined);
    expect(load).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith("memory_summary_unavailable");
  });
  it("deadline aborts provider and cannot persist a late result", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let release: ((text: string) => void) | undefined;
    const persist = vi.fn(),
      fail = vi.fn();
    const provider = {
      summarize: vi.fn(({ signal: input }: { signal: AbortSignal }) => {
        signal = input;
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      }),
    };
    const result = processMemorySummaryJob(
      { load: () => Promise.resolve(work), persist, fail },
      provider,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(signal?.aborted).toBe(true);
    expect(fail).toHaveBeenCalledWith("memory_summary_failed");
    release?.("late output");
    await Promise.resolve();
    expect(persist).not.toHaveBeenCalled();
  });
  it("generated action receipts cannot become summary source evidence", async () => {
    const provider = { summarize: vi.fn(() => Promise.resolve("unsafe")) },
      persist = vi.fn(),
      fail = vi.fn();
    await processMemorySummaryJob(
      {
        load: () =>
          Promise.resolve<MemorySummaryWork>({
            ...work,
            turns: [
              {
                id: "note",
                text: "Invented action",
                source: "verified_action",
              },
            ],
          }),
        persist,
        fail,
      },
      provider,
    );
    expect(provider.summarize).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith("memory_summary_failed");
  });
  it("fresh persistence denial is recorded using only a static failure code", async () => {
    const fail = vi.fn();
    await processMemorySummaryJob(
      {
        load: () => Promise.resolve(work),
        persist: () => Promise.reject(new Error("private synthetic data")),
        fail,
      },
      { summarize: () => Promise.resolve("untrusted customer summary") },
    );
    expect(fail).toHaveBeenCalledWith("memory_summary_failed");
  });
});
