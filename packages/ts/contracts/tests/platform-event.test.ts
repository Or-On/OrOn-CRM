import { describe, expect, it } from "vitest";

import { isPlatformEventV1 } from "../src/index.js";

describe("platform event v1", () => {
  it("accepts a versioned event envelope", () => {
    expect(
      isPlatformEventV1({
        schema_version: "1.0",
        event_id: "4eb654a5-744b-4af6-ad5d-d33782305bf5",
        event_type: "system.health.changed",
        occurred_at: "2026-08-31T18:00:00Z",
        source: "control-api",
        tenant_id: null,
        trace_id: "trace-fixture",
        data: { readiness: "ready" },
      }),
    ).toBe(true);
  });

  it("rejects unversioned or malformed messages", () => {
    expect(isPlatformEventV1({ event_type: "not valid", data: {} })).toBe(
      false,
    );
  });
});
