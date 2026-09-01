import { describe, expect, it } from "vitest";

import { issueServiceAssertion } from "@or-on/auth";

import { validateLiveAgentGrant } from "../src/auth.js";

const secret = "live-agent-test-secret-with-thirty-two-safe-characters";
const identity = {
  role: "agent" as const,
  sessionId: "00000000-0000-4000-8000-000000000001",
  tenantId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
};

describe("live-agent handshake authentication", () => {
  it("accepts only an audience- and capability-bound grant", async () => {
    const token = await issueServiceAssertion({
      audience: "live-agent",
      capability: "live-session",
      identity,
      secret,
    });
    await expect(validateLiveAgentGrant(token, secret)).resolves.toMatchObject(
      identity,
    );
  });

  it("rejects a valid assertion without the live-session capability", async () => {
    const token = await issueServiceAssertion({
      audience: "live-agent",
      identity,
      secret,
    });
    await expect(validateLiveAgentGrant(token, secret)).rejects.toThrow(
      "does not allow",
    );
  });
});
