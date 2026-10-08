import { describe, it, expect } from "vitest";
import { parseResetPublicationPolicies } from "./agent-reset.js";
describe("reviewed reset publication policies", () => {
  it("keeps absent references pinned and permits a different policy per trigger", () => {
    const defaults = parseResetPublicationPolicies(undefined);
    expect(defaults.canonicalAgent).toBe("pinned");
    expect(defaults.nodeAgent).toBe("pinned");
    expect(defaults.retainedVoice).toBe("pinned");
    expect(Object.values(defaults.processes).every((p) => p === "pinned")).toBe(
      true,
    );
    const optIn = parseResetPublicationPolicies({
      canonicalAgent: "follow_published",
      processes: { "voice.inbound": "follow_published" },
    });
    expect(optIn.processes["voice.inbound"]).toBe("follow_published");
    expect(optIn.processes["voice.outbound_assignment"]).toBe("pinned");
  });
  it.each([
    { canonicalAgent: "latest" },
    { retainedVoice: "auto" },
    { nodeAgent: "follow" },
    { processes: { "voice.any": "pinned" } },
    { processes: { "voice.inbound": "latest" } },
    { all: "follow_published" },
    { processes: [] },
  ])("rejects unsupported authored policies %j", (input) => {
    expect(() => parseResetPublicationPolicies(input)).toThrow();
  });
});
