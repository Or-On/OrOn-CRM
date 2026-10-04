export interface ScheduledReply {
  readonly jobId: string;
  readonly tenantId: string;
  readonly conversationId: string;
  /** Claim, renew, fence and finish inside this callback, after admission. */
  readonly run: () => Promise<void>;
}
export type ScheduledReplyResult =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: unknown };
interface PendingReply {
  readonly work: ScheduledReply;
  readonly promise: Promise<ScheduledReplyResult>;
  readonly resolve: (result: ScheduledReplyResult) => void;
}

/** In-process admission only. Database ownership/fencing remains mandatory.
 * Default off: one active callback. Explicit enable:4 global/2tenant/1conversation.
 * Never preclaim jobs waiting here: queued leases would expire before execution.
 */
export class FairReplyScheduler {
  private readonly pending: PendingReply[] = [];
  private readonly admitted = new Map<string, PendingReply>();
  private readonly tenants = new Map<string, number>();
  private readonly conversations = new Set<string>();
  private active = 0;
  private lastTenant: string | undefined;
  private closed = false;
  public constructor(
    private readonly enabled = false,
    private readonly maximumPending = 64,
  ) {
    if (
      !Number.isSafeInteger(maximumPending) ||
      maximumPending < 1 ||
      maximumPending > 1000
    )
      throw new TypeError("Pending scheduler bound must be1..1000");
  }
  public snapshot(): { active: number; pending: number; accepting: boolean } {
    return {
      active: this.active,
      pending: this.pending.length,
      accepting: !this.closed,
    };
  }
  public submit(work: ScheduledReply): Promise<ScheduledReplyResult> {
    if (!work.jobId || !work.tenantId || !work.conversationId)
      return Promise.reject(
        new TypeError(
          "Server-owned job, tenant and conversation identifiers required",
        ),
      );
    const existing = this.admitted.get(work.jobId);
    if (existing) {
      if (
        existing.work.tenantId !== work.tenantId ||
        existing.work.conversationId !== work.conversationId
      )
        return Promise.reject(
          new Error("Job identity conflicts with existing admission"),
        );
      return existing.promise;
    }
    if (this.closed)
      return Promise.reject(new Error("Reply scheduler is draining"));
    if (this.pending.length >= this.maximumPending)
      return Promise.reject(new Error("Reply scheduler pending bound reached"));
    let resolveResult: (result: ScheduledReplyResult) => void = () => {
      throw new Error("Result promise uninitialized");
    };
    const promise = new Promise<ScheduledReplyResult>((resolve) => {
      resolveResult = resolve;
    });
    const pending = { work, promise, resolve: resolveResult };
    this.admitted.set(work.jobId, pending);
    this.pending.push(pending);
    this.pump();
    return promise;
  }
  private conversationKey(work: ScheduledReply): string {
    return JSON.stringify([work.tenantId, work.conversationId]);
  }
  private pump(): void {
    const cap = this.enabled ? 4 : 1;
    while (this.active < cap) {
      const eligible = this.pending
        .map((item, index) => ({ item, index }))
        .filter(
          ({ item }) =>
            (this.tenants.get(item.work.tenantId) ?? 0) <
              (this.enabled ? 2 : 1) &&
            !this.conversations.has(this.conversationKey(item.work)),
        );
      const selected =
        eligible.find(({ item }) => item.work.tenantId !== this.lastTenant) ??
        eligible[0];
      if (!selected) return;
      const [entry] = this.pending.splice(selected.index, 1);
      if (!entry) throw new Error("Scheduler admission changed unexpectedly");
      const work = entry.work;
      const key = this.conversationKey(work);
      this.active += 1;
      this.tenants.set(
        work.tenantId,
        (this.tenants.get(work.tenantId) ?? 0) + 1,
      );
      this.conversations.add(key);
      this.lastTenant = work.tenantId;
      void Promise.resolve()
        .then(work.run)
        .then(
          () => entry.resolve({ status: "completed" }),
          (error: unknown) => entry.resolve({ status: "failed", error }),
        )
        .finally(() => {
          this.active -= 1;
          const remaining = (this.tenants.get(work.tenantId) ?? 1) - 1;
          if (remaining) this.tenants.set(work.tenantId, remaining);
          else this.tenants.delete(work.tenantId);
          this.conversations.delete(key);
          this.admitted.delete(work.jobId);
          this.pump();
        });
    }
  }
  /** Stop accepting and finish already-admitted work before pool/spool closure. */
  public async drain(): Promise<void> {
    this.closed = true;
    while (this.admitted.size) {
      await Promise.all(
        [...this.admitted.values()].map((entry) => entry.promise),
      );
      await Promise.resolve();
    }
  }
}
