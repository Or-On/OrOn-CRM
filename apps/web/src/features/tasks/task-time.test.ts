import { describe, expect, it } from "vitest";

import { taskDueAtInput, taskDueAtInstant } from "./task-time";

describe("task tenant time", () => {
  it("round-trips a Jerusalem deadline independently of the browser timezone", () => {
    const instant = taskDueAtInstant("2026-09-16T10:30", "Asia/Jerusalem");

    expect(instant).toBe("2026-09-16T07:30:00.000Z");
    expect(taskDueAtInput(instant, "Asia/Jerusalem")).toBe("2026-09-16T10:30");
  });

  it("rejects a nonexistent daylight-saving wall-clock time", () => {
    expect(() =>
      taskDueAtInstant("2026-03-08T02:30", "America/New_York"),
    ).toThrow("does not exist");
  });
});
