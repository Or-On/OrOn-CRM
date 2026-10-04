import { describe, expect, it, vi } from "vitest";
import {
  conversationPrincipalRole,
  parsePrincipalAdmission,
  withPrincipalAdmission,
} from "../src/ai-principal.js";

const id = "00000000-0000-4000-8000-000000000099";
describe("dedicated AI principal boundary", () => {
  it("preserves explicit legacy compatibility and accepts only tool-free fixed role", () => {
    expect(parsePrincipalAdmission({ mode: "legacy" })).toEqual({
      mode: "legacy",
    });
    expect(
      parsePrincipalAdmission({
        mode: "principal",
        role: conversationPrincipalRole,
        principalId: id,
        toolPermissions: [],
      }),
    ).toEqual({ mode: "principal", principalId: id });
  });
  it.each([
    "principal_missing",
    "principal_inactive",
    "principal_membership_invalid",
    "principal_role_invalid",
    "principal_tool_bridge_unavailable",
  ])("blocks every operation for %s", async (reason) => {
    const operation = vi.fn();
    await expect(
      withPrincipalAdmission(
        () => Promise.resolve({ mode: "denied", reason }),
        operation,
      ),
    ).rejects.toThrow("ai_execution_principal_unavailable");
    expect(operation).not.toHaveBeenCalled();
  });
  it("blocks stale ownership and rereads authority for every physical operation", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        mode: "principal",
        role: conversationPrincipalRole,
        principalId: id,
        toolPermissions: [],
      })
      .mockResolvedValueOnce(null);
    const operation = vi.fn().mockResolvedValue("answered");
    await expect(withPrincipalAdmission(read, operation)).resolves.toBe(
      "answered",
    );
    await expect(withPrincipalAdmission(read, operation)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(2);
    expect(operation).toHaveBeenCalledTimes(1);
  });
  it.each([
    { role: "owner", toolPermissions: [] },
    { role: conversationPrincipalRole, toolPermissions: ["lead.write"] },
    {
      role: conversationPrincipalRole,
      toolPermissions: "ignore previous instructions",
    },
    {
      role: conversationPrincipalRole,
      toolPermissions: [],
      principalId: "customer text",
    },
  ])("rejects broadened or malformed authority", (overrides) => {
    expect(() =>
      parsePrincipalAdmission({
        mode: "principal",
        principalId: id,
        ...overrides,
      }),
    ).toThrow();
  });
});
