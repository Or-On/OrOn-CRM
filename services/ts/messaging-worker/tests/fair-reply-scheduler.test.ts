import { describe, expect, it } from "vitest";
import { FairReplyScheduler } from "../src/fair-reply-scheduler.js";

function gate() {
  let finish: () => void = () => {
    throw new Error("not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
describe("fair bounded reply admission", () => {
  it("a slow busy tenant cannot occupy more than2slots or delay another tenant", async () => {
    const scheduler = new FairReplyScheduler(true),
      slow = gate();
    const started: string[] = [];
    const jobs = Array.from({ length: 6 }, (_, index) =>
      scheduler.submit({
        jobId: `a${String(index)}`,
        tenantId: "a",
        conversationId: `a${String(index)}`,
        run: () => {
          started.push(`a${String(index)}`);
          return slow.promise;
        },
      }),
    );
    const other = scheduler.submit({
      jobId: "b1",
      tenantId: "b",
      conversationId: "b1",
      run: () => {
        started.push("b1");
        return Promise.resolve();
      },
    });
    await tick();
    expect(started.filter((id) => id.startsWith("a"))).toHaveLength(2);
    expect(started).toContain("b1");
    expect(await other).toEqual({ status: "completed" });
    slow.finish();
    await Promise.all(jobs);
    await scheduler.drain();
  });
  it("caps4globally and prevents same-conversation overlap while other conversations progress", async () => {
    const scheduler = new FairReplyScheduler(true),
      blocked = gate();
    const started: string[] = [];
    const submit = (jobId: string, tenantId: string, conversationId: string) =>
      scheduler.submit({
        jobId,
        tenantId,
        conversationId,
        run: () => {
          started.push(jobId);
          return blocked.promise;
        },
      });
    const jobs = [
      submit("a1", "a", "same"),
      submit("a2", "a", "same"),
      submit("a3", "a", "other"),
      submit("b1", "b", "one"),
      submit("b2", "b", "two"),
      submit("c1", "c", "one"),
    ];
    await tick();
    expect(scheduler.snapshot().active).toBe(4);
    expect(started).not.toContain("a2");
    blocked.finish();
    await Promise.all(jobs);
    await scheduler.drain();
    expect(started).toContain("a2");
  });
  it("defaults sequential, deduplicates same job, refuses conflicting tenant and drains failures safely", async () => {
    const scheduler = new FairReplyScheduler(),
      blocked = gate();
    let calls = 0;
    const work = {
      jobId: "a",
      tenantId: "a",
      conversationId: "one",
      run: () => {
        calls += 1;
        return blocked.promise;
      },
    };
    const first = scheduler.submit(work);
    expect(scheduler.submit(work)).toBe(first);
    await expect(
      scheduler.submit({ ...work, tenantId: "other" }),
    ).rejects.toThrow("conflicts");
    const failed = scheduler.submit({
      jobId: "b",
      tenantId: "b",
      conversationId: "two",
      run: () => Promise.reject(new Error("synthetic failure")),
    });
    await tick();
    expect(calls).toBe(1);
    expect(scheduler.snapshot().active).toBe(1);
    const drained = scheduler.drain();
    await expect(scheduler.submit({ ...work, jobId: "new" })).rejects.toThrow(
      "draining",
    );
    blocked.finish();
    expect(await failed).toMatchObject({ status: "failed" });
    await drained;
    expect(scheduler.snapshot()).toEqual({
      active: 0,
      pending: 0,
      accepting: false,
    });
  });
  it("rejects bounded backlog without starting an unadmitted callback", async () => {
    const scheduler = new FairReplyScheduler(false, 1),
      blocked = gate();
    const first = scheduler.submit({
      jobId: "a",
      tenantId: "a",
      conversationId: "a",
      run: () => blocked.promise,
    });
    const second = scheduler.submit({
      jobId: "b",
      tenantId: "b",
      conversationId: "b",
      run: () => Promise.resolve(),
    });
    await expect(
      scheduler.submit({
        jobId: "c",
        tenantId: "c",
        conversationId: "c",
        run: () => Promise.resolve(),
      }),
    ).rejects.toThrow("bound");
    blocked.finish();
    await Promise.all([first, second]);
    await scheduler.drain();
  });
});
