import { describe, expect, it } from "vitest";
import { orchestrationLocation } from "../src/features/orchestration";

describe("orchestration deep-link state", () => {
  it("retains contact scope when switching tabs", () => {
    expect(
      orchestrationLocation(
        "handoffs",
        "?contact=fictional-contact&tab=activity",
      ),
    ).toBe("/orchestration?contact=fictional-contact&tab=handoffs");
  });
  it("produces a shareable explicit tab from the default view", () => {
    expect(orchestrationLocation("flows", "")).toBe("/orchestration?tab=flows");
  });
});
