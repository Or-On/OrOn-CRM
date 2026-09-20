import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  archiveAgentProfile,
  listHandoffs,
  queueWhatsAppAutomaticCall,
  queueWhatsAppTriggeredCall,
  requestHandoff,
  transitionHandoff,
} from "./cross-channel.js";
import {
  advanceCanonicalSimulation,
  queueCanonicalSimulation,
} from "./flow-runtime.js";
import {
  addMessageReaction,
  assignDefaultWhatsAppAi,
  assignConversation,
  deleteConversation,
  getMessageMediaObjectMetadata,
  markConversationRead,
  setConversationOwnership,
  setConversationStatus,
} from "./messaging.js";

const actorId = "10000000-0000-4000-8000-000000000001";
const contactId = "20000000-0000-4000-8000-000000000001";
const conversationId = "30000000-0000-4000-8000-000000000001";
const messageId = "40000000-0000-4000-8000-000000000001";
const definitionId = "50000000-0000-4000-8000-000000000001";
const runId = "60000000-0000-4000-8000-000000000001";

function fixture(
  respond: (
    statement: string,
    values: readonly unknown[],
  ) => readonly unknown[],
) {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const execute = vi.fn(
    (parts: TemplateStringsArray, ...parameters: unknown[]) => {
      const statement = parts.join("?");
      statements.push(statement);
      values.push(parameters);
      if (statement.includes("current_tenant_feature_enabled"))
        return Promise.resolve([{ enabled: true }]);
      return Promise.resolve(respond(statement, parameters));
    },
  );
  const sql = Object.assign(execute, {
    json: (value: unknown) => value,
  }) as unknown as postgres.TransactionSql;
  return { sql, statements, values };
}

describe("removed Inbox conversation guardrails", () => {
  it("treats every queued conversation side effect as active deletion work", async () => {
    const deletion = fixture((statement) => {
      if (statement.includes("SELECT id, removed_from_inbox_at"))
        return [{ id: conversationId, removed_from_inbox_at: null }];
      if (statement.includes("SELECT (")) return [{ active: true }];
      return [];
    });

    await expect(
      deleteConversation(deletion.sql, conversationId, actorId),
    ).resolves.toEqual({ status: "active_work" });
    const activeWork = deletion.statements.find((statement) =>
      statement.includes("FROM ops.jobs job"),
    );
    expect(activeWork).toContain(
      "job.payload ->> 'conversationId' = ?::uuid::text",
    );
    expect(activeWork).toContain("job.reference_type = 'flow_run'");
    expect(activeWork).toContain(
      "flow_run.trigger_metadata ->> 'conversationId'",
    );
    expect(activeWork).not.toContain("FROM automation.handoffs handoff");
  });

  it("makes normal message and conversation mutations resolve as unavailable", async () => {
    const test = fixture(() => []);

    await expect(
      setConversationStatus(test.sql, conversationId, "closed"),
    ).resolves.toBe(false);
    await expect(
      assignConversation(test.sql, conversationId, null),
    ).resolves.toBe(false);
    await expect(
      setConversationOwnership(test.sql, conversationId, actorId, "human"),
    ).resolves.toBe(false);
    await expect(
      markConversationRead(test.sql, conversationId, actorId),
    ).resolves.toBe(false);
    await expect(
      addMessageReaction(test.sql, messageId, actorId, "👍"),
    ).resolves.toBe(false);
    await expect(
      getMessageMediaObjectMetadata(test.sql, messageId),
    ).resolves.toBeUndefined();

    expect(test.statements).toHaveLength(6);
    for (const statement of test.statements)
      expect(statement).toContain("removed_from_inbox_at IS NULL");
  });

  it("blocks call orchestration and conversation-bound handoffs", async () => {
    const triggered = fixture(() => []);
    await expect(
      queueWhatsAppTriggeredCall(
        triggered.sql,
        actorId,
        conversationId,
        "fixture-triggered-call",
      ),
    ).rejects.toThrow("voice consent");
    expect(triggered.statements[0]).toContain(
      "conversation.removed_from_inbox_at IS NULL",
    );

    const automatic = fixture(() => []);
    await expect(
      queueWhatsAppAutomaticCall(
        automatic.sql,
        actorId,
        conversationId,
        messageId,
        "fixture-automatic-call",
      ),
    ).rejects.toThrow("automatic call policy");
    expect(automatic.statements[0]).toContain(
      "conversation.removed_from_inbox_at IS NULL",
    );
    expect(automatic.statements[0]).toContain(
      "platform.approved_flow_for_channel(flow.id,voice_agent.id,'voice')",
    );

    const handoff = fixture(() => []);
    await expect(
      requestHandoff(
        handoff.sql,
        actorId,
        contactId,
        "whatsapp",
        "Fictional escalation",
        "fixture-handoff",
        { conversationId },
      ),
    ).rejects.toThrow("conversation is unavailable");
    expect(handoff.statements).toHaveLength(2);
    expect(handoff.statements[0]).toContain("automation.handoffs");
    expect(handoff.statements[1]).toContain("removed_from_inbox_at IS NULL");
  });

  it("excludes removed conversation handoffs from queue reads and transitions", async () => {
    const listed = fixture(() => []);
    await expect(listHandoffs(listed.sql)).resolves.toEqual([]);
    expect(listed.statements[0]).toContain(
      "conversation.removed_from_inbox_at IS NULL",
    );

    const transitioned = fixture(() => []);
    await expect(
      transitionHandoff(transitioned.sql, runId, actorId, "accept"),
    ).rejects.toThrow("invalid handoff transition");
    expect(transitioned.statements[0]).toContain(
      "conversation.removed_from_inbox_at IS NULL",
    );
  });

  it("allows agent archival only when no Inbox-visible thread still owns it", async () => {
    const archive = fixture((statement) => {
      if (statement.includes("SELECT id FROM agents.agent_profiles"))
        return [{ id: definitionId }];
      if (statement.includes("SELECT EXISTS")) return [{ present: true }];
      return [];
    });
    await expect(
      archiveAgentProfile(archive.sql, actorId, definitionId),
    ).resolves.toBe("active");
    expect(archive.statements[1]).toContain("pg_advisory_xact_lock");
    expect(archive.statements[3]).toContain(
      "conversation.removed_from_inbox_at IS NULL",
    );
  });

  it("requires an unarchived locked profile before assigning AI ownership", async () => {
    const automatic = fixture((statement) =>
      statement.includes("SELECT profile.id") ? [{ id: definitionId }] : [],
    );
    await expect(
      assignDefaultWhatsAppAi(automatic.sql, conversationId),
    ).resolves.toBe(false);
    expect(automatic.statements).toHaveLength(5);
    expect(automatic.statements[2]).toContain("profile.archived_at IS NULL");
    expect(automatic.statements[3]).toContain("pg_advisory_xact_lock");
    expect(automatic.statements[4]).toContain("profile.archived_at IS NULL");

    const manual = fixture((statement) =>
      statement.includes("SELECT agent_profile_id")
        ? [{ agent_profile_id: definitionId }]
        : [],
    );
    await expect(
      setConversationOwnership(
        manual.sql,
        conversationId,
        actorId,
        "ai",
        definitionId,
      ),
    ).rejects.toThrow("a published WhatsApp agent is required");
    expect(manual.statements).toHaveLength(3);
    expect(manual.statements[1]).toContain("pg_advisory_xact_lock");
    expect(manual.statements[2]).toContain("profile.archived_at IS NULL");
  });

  it("refuses new and already-queued canonical simulations after removal", async () => {
    const definition = {
      schemaVersion: "1.0",
      channels: ["whatsapp"],
      nodes: [
        { id: "start", type: "start" },
        { id: "end", type: "end" },
      ],
      edges: [{ id: "finish", source: "start", target: "end" }],
    };
    const queued = fixture((statement) => {
      if (statement.includes("canonical_actor_authorized"))
        return [{ allowed: true }];
      if (statement.includes("SELECT flow.id"))
        return [
          {
            id: runId,
            definition,
            channel_capabilities: ["whatsapp"],
          },
        ];
      return [];
    });
    await expect(
      queueCanonicalSimulation(
        queued.sql,
        actorId,
        definitionId,
        conversationId,
        "whatsapp",
        "fixture-simulation",
      ),
    ).rejects.toThrow("conversation is unavailable");
    expect(
      queued.statements.find((statement) =>
        statement.includes("SELECT contact_id FROM messaging.conversations"),
      ),
    ).toContain("removed_from_inbox_at IS NULL");

    const advancing = fixture((statement) => {
      if (statement.includes("FROM automation.flow_runs run"))
        return [
          {
            id: runId,
            contact_id: contactId,
            definition,
            status: "running",
            trigger_metadata: {
              actorUserId: actorId,
              conversationId,
              channel: "whatsapp",
            },
            expired: false,
            variables: {},
          },
        ];
      if (statement.includes("canonical_actor_authorized"))
        return [{ allowed: true }];
      return [];
    });
    await expect(
      advanceCanonicalSimulation(advancing.sql, runId),
    ).rejects.toThrow("conversation is unavailable");
    expect(
      advancing.statements.find((statement) =>
        statement.includes("SELECT id FROM messaging.conversations"),
      ),
    ).toContain("removed_from_inbox_at IS NULL");
  });
});
