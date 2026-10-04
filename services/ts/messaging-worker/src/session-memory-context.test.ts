import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { loadSessionMemoryContext } from "./session-memory-context.js";

const scope = {
  tenantId: "tenant",
  conversationId: "conversation",
  agentVersionId: "agent",
  contactId: "contact",
  latestTriggerMessageId: "trigger",
};
describe("session memory prompt opt-in", () => {
  it("does not even resolve a session while the tenant flag is off", async () => {
    let queries = 0;
    const sql = (() => {
      queries++;
      return Promise.resolve([]);
    }) as unknown as postgres.TransactionSql;
    expect(await loadSessionMemoryContext(sql, scope)).toEqual({
      sessionId: null,
      context: "",
      shadow: true,
      turnIds: [],
      correctionsPresent: false,
    });
    expect(queries).toBe(2);
  });
  it("does not resolve a session when stored routing/ownership does not match", async () => {
    let queries = 0;
    const sql = (() =>
      Promise.resolve(
        ++queries === 1 ? [{ enabled: true }] : [],
      )) as unknown as postgres.TransactionSql;
    expect(
      (await loadSessionMemoryContext(sql, scope, { shadow: false })).context,
    ).toBe("");
    expect(queries).toBe(2);
  });
});
