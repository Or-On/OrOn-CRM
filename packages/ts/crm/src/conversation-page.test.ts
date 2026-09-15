import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { listConversationPage, parseConversationCursor } from "./messaging.js";

const firstId = "30000000-0000-4000-8000-000000000003";
const secondId = "30000000-0000-4000-8000-000000000002";
const thirdId = "30000000-0000-4000-8000-000000000001";

function row(id: string, cursor: string) {
  return {
    id,
    contact_id: `40000000-0000-4000-8000-${id.slice(-12)}`,
    contact_name: `Fictional ${id.slice(-1)}`,
    status: "open",
    unread_count: 0,
    last_message_at: new Date("2026-09-15T10:00:00.123Z"),
    last_message_preview: "Fixture",
    assigned_user_id: null,
    ownership_mode: "human",
    ai_agent_profile_version_id: null,
    ai_enabled_at: null,
    handoff_reason_safe: null,
    channel_kind: "whatsapp",
    provider: "meta",
    sender_address: "+972500000000",
    provider_account_id: "fictional-account",
    recipient_address: "+972500000001",
    whatsapp_consent: "granted",
    whatsapp_opted_out_at: null,
    customer_service_window_expires_at: null,
    cursor_last_message_at: cursor,
  };
}

describe("conversation list pagination", () => {
  it("uses a tenant-bound stable keyset and preserves cursor microseconds", async () => {
    const unsafe = vi
      .fn()
      .mockResolvedValue([
        row(firstId, "2026-09-15T10:00:00.123456Z"),
        row(secondId, "2026-09-15T10:00:00.123455Z"),
        row(thirdId, "2026-09-15T10:00:00.123454Z"),
      ]);
    const sql = { unsafe } as unknown as postgres.TransactionSql;

    const page = await listConversationPage(sql, {
      query: "Fictional",
      filter: "unread",
      channelKind: "whatsapp",
      currentUserId: "20000000-0000-4000-8000-000000000001",
      before: {
        lastMessageAt: "2026-09-15T11:00:00.999999Z",
        id: firstId,
      },
      limit: 2,
    });

    expect(page.conversations.map((conversation) => conversation.id)).toEqual([
      firstId,
      secondId,
    ]);
    expect(page.nextCursor).toEqual({
      lastMessageAt: "2026-09-15T10:00:00.123455Z",
      id: secondId,
    });
    const [statement, parameters] = unsafe.mock.calls[0] as [string, unknown[]];
    expect(statement).toContain(
      "WHERE c.tenant_id = platform.current_tenant_id()",
    );
    expect(statement).toContain(
      "JOIN crm.contacts contact\n         ON contact.id = c.contact_id AND contact.tenant_id = c.tenant_id",
    );
    expect(statement).toContain(
      "ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC",
    );
    expect(parameters).toEqual([
      null,
      "Fictional",
      "unread",
      "20000000-0000-4000-8000-000000000001",
      "whatsapp",
      "2026-09-15T11:00:00.999999Z",
      firstId,
      3,
    ]);
  });

  it("validates complete nullable cursors and Mine ownership", async () => {
    expect(parseConversationCursor(null, null)).toBeUndefined();
    expect(parseConversationCursor(null, firstId)).toEqual({
      lastMessageAt: null,
      id: firstId,
    });
    expect(() => parseConversationCursor("not-a-date", firstId)).toThrow(
      "Invalid",
    );
    expect(() => parseConversationCursor(null, "not-a-uuid")).toThrow(
      "Invalid",
    );
    const sql = {
      unsafe: vi.fn(),
    } as unknown as postgres.TransactionSql;
    await expect(listConversationPage(sql, { filter: "mine" })).rejects.toThrow(
      "Current user",
    );
  });
});
