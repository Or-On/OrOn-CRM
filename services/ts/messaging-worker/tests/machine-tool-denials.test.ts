import { describe, expect, it } from "vitest";
import type postgres from "postgres";
import { authorizeMachineTool } from "../src/machine-tools.js";
import { AiPrincipalDeniedError } from "../src/ai-principal.js";

describe("machine tool denial diagnostics", () => {
  it.each([
    ["machine_tool_denied", "machine_tool_denied"],
    ["machine_tool_source_superseded", "machine_tool_source_superseded"],
    ["machine_tool_stale_claim", "machine_tool_stale_claim"],
    ["machine_tool_job_binding_changed", "machine_tool_job_binding_changed"],
    [
      "machine_tool_claim_binding_changed",
      "machine_tool_claim_binding_changed",
    ],
    [
      "private customer text or SQL details",
      "ai_execution_principal_unavailable",
    ],
  ])("retains only the bounded code for %s", async (message, expected) => {
    const sql = (() => {
      throw Object.assign(new Error(message), { code: "42501" });
    }) as unknown as postgres.TransactionSql;
    const promise = authorizeMachineTool(
      sql,
      { id: "job", claim_token: "claim" },
      "worker",
      "ticket.open",
      {
        agentVersionId: "agent",
        conversationId: "conversation",
        contactId: "contact",
        triggerMessageId: "message",
        ownershipEpoch: "7",
      },
    );
    await expect(promise).rejects.toBeInstanceOf(AiPrincipalDeniedError);
    await expect(promise).rejects.toThrow(expected);
  });
});
