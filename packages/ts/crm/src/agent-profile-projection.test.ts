import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { listAgentProfiles } from "./cross-channel.js";

describe("tenant agent configuration projection", () => {
  it("projects only explicit stored configuration alongside latest-version metadata", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        id: "agent",
        name: "Fictional agent",
        description: null,
        version: 2,
        version_id: "version",
        channel_capabilities: ["voice"],
        published_at: new Date(),
        validation_status: "valid",
        system_prompt: "Fictional instructions",
        locale: "he-IL",
        private_credential: "not projected",
      },
    ]);
    const records = await listAgentProfiles(
      query as unknown as postgres.TransactionSql,
    );
    expect(records[0]).toMatchObject({
      systemPrompt: "Fictional instructions",
      locale: "he-IL",
      version: 2,
      published: true,
    });
    expect(records[0]).not.toHaveProperty("private_credential");
    expect(query).toHaveBeenCalledOnce();
    const parts = query.mock.calls[0]?.[0] as TemplateStringsArray;
    expect(parts.join("")).toContain(
      "candidate.system_prompt, candidate.locale",
    );
    expect(parts.join("")).toContain("ORDER BY candidate.version DESC LIMIT 1");
    expect(parts.join("")).not.toMatch(/INSERT|UPDATE|DELETE/u);
  });

  it("projects an agent with no pinned lead schema instead of failing the list", async () => {
    // The lead schema arrives through a LEFT JOIN, so an agent that collects
    // nothing leaves those columns empty. Reading the register must survive
    // that: the strict field parser belongs behind the join, not in front of
    // every row.
    const query = vi.fn().mockResolvedValue([
      {
        id: "agent",
        name: "Fictional agent",
        description: null,
        version: 1,
        version_id: "version",
        channel_capabilities: ["whatsapp"],
        published_at: null,
        validation_status: "valid",
        system_prompt: "Fictional instructions",
        locale: "he-IL",
        schema_id: null,
        schema_name: null,
        schema_version: null,
        schema_definition: null,
      },
    ]);

    const records = await listAgentProfiles(
      query as unknown as postgres.TransactionSql,
    );

    expect(records[0]?.leadFieldSchema).toBeNull();
    expect(records[0]?.capabilities).toEqual([]);
  });
});
