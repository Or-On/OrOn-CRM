import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  dashboardMetrics,
  overviewInsights,
  overviewMetrics,
} from "./analytics.js";

function transaction(results: readonly unknown[][]) {
  const statements: string[] = [];
  const execute = vi.fn((parts: TemplateStringsArray) => {
    statements.push(parts.join("?"));
    return Promise.resolve(results[statements.length - 1] ?? []);
  });
  return {
    sql: execute as unknown as postgres.TransactionSql,
    statements,
  };
}

describe("operational conversation analytics", () => {
  it("excludes removed conversations from state charts but keeps message history independent", async () => {
    const fixture = transaction([[], []]);

    await overviewInsights(fixture.sql);

    expect(fixture.statements[0]).toContain("FROM messaging.messages");
    expect(fixture.statements[0]).not.toContain("removed_from_inbox_at");
    expect(fixture.statements[1]).toContain(
      "WHERE removed_from_inbox_at IS NULL",
    );
  });

  it("excludes removed conversations from overview open counts", async () => {
    const fixture = transaction([
      [{ contacts: 0, open_conversations: 0, pending_handoffs: 0 }],
    ]);

    await overviewMetrics(fixture.sql);

    expect(fixture.statements[0]).toContain(
      "WHERE removed_from_inbox_at IS NULL",
    );
  });

  it("excludes removed conversations from dashboard open and unread counts", async () => {
    const fixture = transaction([
      [
        {
          contacts: 0,
          open_conversations: 0,
          unread_messages: 0,
          open_pipeline_value: "0",
          messages_today: 0,
        },
      ],
      [],
    ]);

    await dashboardMetrics(fixture.sql);

    expect(
      fixture.statements[0]?.match(/removed_from_inbox_at IS NULL/gu),
    ).toHaveLength(2);
    expect(fixture.statements[0]).toContain(
      "FROM messaging.messages WHERE created_at",
    );
  });
});
