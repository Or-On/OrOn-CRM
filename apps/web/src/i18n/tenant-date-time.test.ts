import { describe, expect, it } from "vitest";

import { tenantDateFormatter } from "./tenant-date-time";

describe("tenantDateFormatter", () => {
  it("formats an instant in the explicit tenant timezone", () => {
    const instant = new Date("2026-09-15T21:30:00.000Z");
    const options = {
      dateStyle: "medium",
      timeStyle: "short",
    } as const;

    expect(tenantDateFormatter("en-US", "UTC", options).format(instant)).toBe(
      "Sep 15, 2026, 9:30 PM",
    );
    expect(
      tenantDateFormatter("en-US", "Asia/Jerusalem", options).format(instant),
    ).toBe("Sep 16, 2026, 12:30 AM");
  });

  it("keeps date-only displays in the tenant calendar day", () => {
    const instant = new Date("2026-09-15T00:30:00.000Z");
    const options = { dateStyle: "medium" } as const;

    expect(
      tenantDateFormatter("en-US", "America/Los_Angeles", options).format(
        instant,
      ),
    ).toBe("Sep 14, 2026");
    expect(
      tenantDateFormatter("en-US", "Asia/Jerusalem", options).format(instant),
    ).toBe("Sep 15, 2026");
  });

  it("falls back to UTC when a legacy tenant timezone is invalid", () => {
    const instant = new Date("2026-09-15T21:30:00.000Z");

    expect(
      tenantDateFormatter("en-US", "Mars/Olympus_Mons", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(instant),
    ).toBe("Sep 15, 2026, 9:30 PM");
  });
});
