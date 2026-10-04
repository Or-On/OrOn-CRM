export interface HandoffResumeState {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly ownershipEpoch: number;
  readonly enabled: boolean;
  readonly ownership: "ai" | "human";
  readonly handoffStatus: "pending" | "accepted" | "resolved" | "cancelled";
  readonly handoffAt: Date;
  readonly humanRepliedSinceHandoff: boolean;
  readonly activeHuman: boolean;
  readonly nextSession: boolean;
  readonly timezone?: string;
  readonly businessHours?: Readonly<
    Record<
      string,
      {
        readonly closed: boolean;
        readonly opensAt?: string;
        readonly closesAt?: string;
      }
    >
  >;
}

/** Never infer a schedule or timezone. Count actual elapsed business time,
 * including partial minutes and DST, within a bounded seven-day lookback. */
export function elapsedBusinessMinutes(
  state: HandoffResumeState,
  now: Date,
): number | null {
  if (
    !state.timezone ||
    !state.businessHours ||
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(state.handoffAt.getTime()) ||
    now < state.handoffAt
  )
    return null;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: state.timezone,
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return null;
  }
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/u;
  for (const day of Object.values(state.businessHours))
    if (
      !day.closed &&
      (!day.opensAt ||
        !day.closesAt ||
        !clock.test(day.opensAt) ||
        !clock.test(day.closesAt) ||
        day.opensAt >= day.closesAt)
    )
      return null;
  let count = 0;
  const end = now.getTime(),
    start = Math.max(state.handoffAt.getTime(), end - 7 * 24 * 60 * 60 * 1000);
  for (let cursor = start; cursor < end;) {
    const until = Math.min(end, Math.floor(cursor / 60000) * 60000 + 60000);
    const parts = formatter.formatToParts(new Date(cursor));
    const part = (key: string) => parts.find((p) => p.type === key)?.value;
    const day = state.businessHours[(part("weekday") ?? "").toLowerCase()];
    const hour = part("hour"),
      minute = part("minute");
    if (hour === undefined || minute === undefined) return null;
    const time = `${hour}:${minute}`;
    if (
      day &&
      !day.closed &&
      day.opensAt !== undefined &&
      day.closesAt !== undefined &&
      day.opensAt <= time &&
      time < day.closesAt
    )
      count += (until - cursor) / 60000;
    cursor = until;
    if (count >= 15) return count;
  }
  return count;
}

export function handoffResumeReason(
  state: HandoffResumeState,
  now: Date,
): "closed" | "next_session" | "unattended" | null {
  if (!state.enabled || state.ownership !== "human" || state.activeHuman)
    return null;
  if (state.handoffStatus === "resolved" || state.handoffStatus === "cancelled")
    return "closed";
  if (state.nextSession) return "next_session";
  if (state.humanRepliedSinceHandoff) return null;
  const elapsed = elapsedBusinessMinutes(state, now);
  return elapsed !== null && elapsed >= 15 ? "unattended" : null;
}

/** Adapter must execute all callbacks in ONE tenant-scoped transaction, lock
 * stored conversation/handoff, and compare the epoch again in the final write.
 * No caller/model tenant or role may populate the state. */
export interface HandoffResumeTransaction {
  readLocked(): Promise<HandoffResumeState>;
  authorizePublishedAgent(): Promise<boolean>;
  resumeAndClearReason(
    expectedEpoch: number,
    reason: "closed" | "next_session" | "unattended",
  ): Promise<boolean>;
}

export async function resumeUnattendedHandoff(
  transaction: HandoffResumeTransaction,
  expectedTenantId: string,
  now: Date,
): Promise<boolean> {
  const state = await transaction.readLocked();
  if (state.tenantId !== expectedTenantId)
    throw new Error("handoff tenant mismatch");
  const reason = handoffResumeReason(state, now);
  if (!reason || !(await transaction.authorizePublishedAgent())) return false;
  return transaction.resumeAndClearReason(state.ownershipEpoch, reason);
}
