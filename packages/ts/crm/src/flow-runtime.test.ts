import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import type { CanonicalFlow } from "./cross-channel.js";
import { validateRetainedReferences } from "./flow-runtime.js";

const voiceFlowId = "10000000-0000-4000-8000-000000000001";
const voiceAgentVersionId = "20000000-0000-4000-8000-000000000001";

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
