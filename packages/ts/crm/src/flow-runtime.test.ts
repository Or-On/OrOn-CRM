import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import type { CanonicalFlow } from "./cross-channel.js";
import {
  saveCanonicalFlowDraft,
  validateRetainedReferences,
} from "./flow-runtime.js";

const voiceFlowId = "10000000-0000-4000-8000-000000000001";
const voiceAgentVersionId = "20000000-0000-4000-8000-000000000001";
const definitionId = "30000000-0000-4000-8000-000000000001";
const actorUserId = "40000000-0000-4000-8000-000000000001";
const canonicalAgentVersionId = "50000000-0000-4000-8000-000000000001";

function retainedVoiceFlow(agentVersionId?: string): CanonicalFlow {
  return {
    schemaVersion: "1.0",
    channels: ["voice"],
    nodes: [
      { id: "start", type: "start" },
      {
        id: "call",
        type: "voice.call",
        configuration: {
          flowId: voiceFlowId,
          flowVersion: 3,
          ...(agentVersionId === undefined ? {} : { agentVersionId }),
        },
      },
      { id: "end", type: "end" },
    ],
    edges: [
      { id: "start-call", source: "start", target: "call" },
      { id: "call-end", source: "call", target: "end" },
    ],
  };
}

function transaction(results: readonly (readonly { available: boolean }[])[]) {
  const statements: string[] = [];
  const values: unknown[][] = [];
  let index = 0;
  const execute = vi.fn(
    (parts: TemplateStringsArray, ...parameters: unknown[]) => {
      statements.push(parts.join("?"));
      values.push(parameters);
      return Promise.resolve(results[index++] ?? []);
    },
  );
  return {
    sql: execute as unknown as postgres.TransactionSql,
    statements,
    values,
  };
}

function draftTransaction(results: readonly (readonly unknown[])[]) {
  const statements: string[] = [];
  const values: unknown[][] = [];
  let index = 0;
  const execute = vi.fn(
    (parts: TemplateStringsArray, ...parameters: unknown[]) => {
      statements.push(parts.join("?"));
      values.push(parameters);
      return Promise.resolve(results[index++] ?? []);
    },
  );
  const sql = Object.assign(execute, {
    json: (value: unknown) => value,
  }) as unknown as postgres.TransactionSql;
  return { sql, statements, values };
}

const editableFlow: CanonicalFlow = {
  schemaVersion: "1.0",
  channels: ["whatsapp"],
  nodes: [
    { id: "start", label: "Customer replied", type: "start" },
    {
      id: "message",
      label: "Send follow-up",
      type: "message.send",
      configuration: { text: "Fictional follow-up" },
    },
    { id: "end", label: "Complete", type: "end" },
  ],
  edges: [
    { id: "start-message", source: "start", target: "message" },
    { id: "message-end", source: "message", target: "end" },
  ],
};

describe("canonical flow retained-reference publication boundary", () => {
  it("requires every pinned voice agent to be same-tenant, published, valid, and voice-capable", async () => {
    const fixture = transaction([[{ available: true }], [{ available: true }]]);

    await expect(
      validateRetainedReferences(
        fixture.sql,
        retainedVoiceFlow(voiceAgentVersionId),
      ),
    ).resolves.toBeUndefined();

    expect(fixture.statements).toHaveLength(2);
    expect(fixture.statements[1]).toContain(
      "agent.tenant_id=platform.current_tenant_id()",
    );
    expect(fixture.statements[1]).toContain("agent.published_at IS NOT NULL");
    expect(fixture.statements[1]).toContain("agent.validation_status='valid'");
    expect(fixture.statements[1]).toContain(
      "agent.channel_capabilities @> ARRAY['voice']::text[]",
    );
    expect(fixture.values[1]).toEqual([voiceAgentVersionId]);
  });

  it("rejects an unavailable pinned voice agent before publication", async () => {
    const fixture = transaction([
      [{ available: true }],
      [{ available: false }],
    ]);

    await expect(
      validateRetainedReferences(
        fixture.sql,
        retainedVoiceFlow(voiceAgentVersionId),
      ),
    ).rejects.toThrow("pinned voice agent version is unavailable");
  });

  it("does not require a separate pinned agent when the voice action inherits the compatible flow agent", async () => {
    const fixture = transaction([[{ available: true }]]);

    await expect(
      validateRetainedReferences(fixture.sql, retainedVoiceFlow()),
    ).resolves.toBeUndefined();
    expect(fixture.statements).toHaveLength(1);
  });
});

describe("canonical flow draft editor persistence", () => {
  it("appends a validated draft version and audits it without updating prior versions", async () => {
    const fixture = draftTransaction([
      [{ id: definitionId }],
      [{ agent_profile_version_id: canonicalAgentVersionId, version: 4 }],
      [{ id: "60000000-0000-4000-8000-000000000001" }],
      [],
      [],
    ]);

    await expect(
      saveCanonicalFlowDraft(
        fixture.sql,
        actorUserId,
        definitionId,
        editableFlow,
      ),
    ).resolves.toEqual({
      version: 5,
      versionId: "60000000-0000-4000-8000-000000000001",
    });

    expect(fixture.statements[0]).toContain(
      "tenant_id=platform.current_tenant_id()",
    );
    expect(fixture.statements[0]).toContain("FOR UPDATE");
    expect(fixture.statements[2]).toContain(
      "INSERT INTO automation.flow_versions",
    );
    expect(fixture.values[2]).toContain(5);
    expect(
      fixture.statements.some((statement) =>
        statement.includes("UPDATE automation.flow_versions"),
      ),
    ).toBe(false);
    expect(fixture.statements[3]).toContain(
      "UPDATE automation.flow_definitions",
    );
    expect(fixture.statements[3]).toContain("SET updated_at=CURRENT_TIMESTAMP");
    expect(fixture.statements[3]).not.toContain("channel_capabilities");
    expect(fixture.statements[4]).toContain("INSERT INTO audit.records");
    expect(fixture.statements[4]).toContain("'flow.draft_saved'");
  });

  it("validates the executable path and configuration before issuing SQL", async () => {
    const fixture = draftTransaction([]);
    const invalid = {
      ...editableFlow,
      nodes: editableFlow.nodes.map((node) =>
        node.id === "message" ? { ...node, configuration: {} } : node,
      ),
    };

    await expect(
      saveCanonicalFlowDraft(fixture.sql, actorUserId, definitionId, invalid),
    ).rejects.toThrow("flow configuration requires text");
    expect(fixture.statements).toEqual([]);
  });

  it("does not disclose or create a version for a missing tenant-local definition", async () => {
    const fixture = draftTransaction([[]]);
    await expect(
      saveCanonicalFlowDraft(
        fixture.sql,
        actorUserId,
        definitionId,
        editableFlow,
      ),
    ).resolves.toBeNull();
    expect(fixture.statements).toHaveLength(1);
  });
});
