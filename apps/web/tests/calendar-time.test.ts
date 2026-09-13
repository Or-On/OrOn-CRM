import { describe, expect, it } from "vitest";

import {
  calendarDateKeyInTimeZone,
  dateTimeLocalInTimeZone,
  instantFromDateTimeLocal,
  resolveCalendarTimeZone,
} from "../src/features/calendar";

describe("calendar time-zone conversion", () => {
  it("round-trips wall-clock values through the selected IANA zone", () => {
    expect(
      dateTimeLocalInTimeZone("2026-09-10T21:30:00.000Z", "Asia/Jerusalem"),
    ).toBe("2026-09-11T00:30");
    expect(instantFromDateTimeLocal("2026-09-11T00:30", "Asia/Jerusalem")).toBe(
      "2026-09-10T21:30:00.000Z",
    );
  });

  it("groups instants by the calendar time zone rather than the host zone", () => {
    expect(
      calendarDateKeyInTimeZone("2026-09-10T21:30:00.000Z", "Asia/Jerusalem"),
    ).toBe("2026-09-11");
  });

  it("rejects nonexistent daylight-saving wall-clock times", () => {
    expect(() =>
      instantFromDateTimeLocal("2026-03-08T02:30", "America/New_York"),
    ).toThrow("does not exist");
  });

  it("falls back to UTC for an invalid legacy tenant time zone", () => {
    expect(resolveCalendarTimeZone("Mars/Olympus_Mons")).toEqual({
      timeZone: "UTC",
      usedFallback: true,
    });
    expect(resolveCalendarTimeZone(" Asia/Jerusalem ")).toEqual({
      timeZone: "Asia/Jerusalem",
      usedFallback: false,
    });
  });
});
