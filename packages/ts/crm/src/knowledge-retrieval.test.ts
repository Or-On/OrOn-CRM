import { describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import { retrieveAgentKnowledge } from "./knowledge-retrieval.js";

describe("trusted knowledge retrieval", () => {
  it("parameterizes hostile questions and retains document-only content", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        tenant_id: "tenant",
        document_id: "document",
        source_id: "source",
        chunk_id: "chunk",
        title: "Hours",
        content: "פתוח ביום ראשון",
        rank: 0.5,
        metadata: { schemaVersion: "1.0", facts: [] },
      },
    ]);
    const question = "'); SELECT secret FROM credentials; --";
    const result = await retrieveAgentKnowledge(
      query as unknown as postgres.TransactionSql,
      { tenantId: "tenant", agentVersionId: "agent", question },
    );
    expect(result[0]?.content).toBe("פתוח ביום ראשון");
    expect(result[0]?.facts).toEqual([]);
    expect(query.mock.calls[0]?.slice(1)).toContain(question);
    expect(
      (query.mock.calls[0]?.[0] as TemplateStringsArray).join(" "),
    ).not.toContain(question);
  });
  it("skips empty and rejects oversized questions before SQL", async () => {
    const query = vi.fn();
    const input = {
      tenantId: "tenant",
      agentVersionId: "agent",
      question: " ",
    };
    expect(
      await retrieveAgentKnowledge(
        query as unknown as postgres.TransactionSql,
        input,
      ),
    ).toEqual([]);
    await expect(
      retrieveAgentKnowledge(query as unknown as postgres.TransactionSql, {
        ...input,
        question: "x".repeat(4097),
      }),
    ).rejects.toThrow("too long");
    expect(query).not.toHaveBeenCalled();
  });
});
