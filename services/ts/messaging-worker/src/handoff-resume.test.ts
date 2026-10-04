import { expect, it, vi } from "vitest";
import {
  handoffResumeReason,
  resumeUnattendedHandoff,
  type HandoffResumeState,
} from "./handoff-resume.js";
const state: HandoffResumeState = {
  tenantId: "tenant",
  conversationId: "conversation",
  ownershipEpoch: 4,
  enabled: true,
  ownership: "human",
  handoffStatus: "pending",
  handoffAt: new Date("2026-10-05T08:55:00Z"),
  humanRepliedSinceHandoff: false,
  activeHuman: false,
  nextSession: false,
  timezone: "Etc/UTC",
  businessHours: {
    monday: { closed: false, opensAt: "09:00", closesAt: "17:00" },
  },
};
it("counts fifteen business minutes rather than wall time", () => {
  const { businessHours, ...withoutBusinessHours } = state;
  expect(businessHours).toBeDefined();
  expect(
    handoffResumeReason(state, new Date("2026-10-05T09:14:59Z")),
  ).toBeNull();
  expect(handoffResumeReason(state, new Date("2026-10-05T09:15:00Z"))).toBe(
    "unattended",
  );
  expect(
    handoffResumeReason(withoutBusinessHours, new Date("2026-10-05T10:00:00Z")),
  ).toBeNull();
});
it("remains default off and preserves an actively owned human session", () => {
  const now = new Date("2026-10-05T10:00:00Z");
  expect(handoffResumeReason({ ...state, enabled: false }, now)).toBeNull();
  expect(
    handoffResumeReason(
      { ...state, activeHuman: true, nextSession: true },
      now,
    ),
  ).toBeNull();
  expect(
    handoffResumeReason({ ...state, humanRepliedSinceHandoff: true }, now),
  ).toBeNull();
  expect(
    handoffResumeReason(
      { ...state, nextSession: true, humanRepliedSinceHandoff: true },
      now,
    ),
  ).toBe("next_session");
  expect(
    handoffResumeReason({ ...state, handoffStatus: "resolved" }, now),
  ).toBe("closed");
});
it("requires fresh authorization and epoch comparison before resuming", async () => {
  const write = vi.fn().mockResolvedValue(false),
    authorize = vi.fn().mockResolvedValue(false);
  const tx = {
    readLocked: () => Promise.resolve(state),
    authorizePublishedAgent: authorize,
    resumeAndClearReason: write,
  };
  expect(
    await resumeUnattendedHandoff(
      tx,
      "tenant",
      new Date("2026-10-05T10:00:00Z"),
    ),
  ).toBe(false);
  expect(write).not.toHaveBeenCalled();
  authorize.mockResolvedValue(true);
  expect(
    await resumeUnattendedHandoff(
      tx,
      "tenant",
      new Date("2026-10-05T10:00:00Z"),
    ),
  ).toBe(false);
  expect(write).toHaveBeenCalledWith(4, "unattended");
  await expect(
    resumeUnattendedHandoff(tx, "foreign", new Date()),
  ).rejects.toThrow("tenant mismatch");
});
