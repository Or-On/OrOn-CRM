import { describe, expect, it } from "vitest";
import { openingMenuSummary, listMessagePage } from "./messaging.js";
import type postgres from "postgres";
const row = {
  id: "30000000-0000-4000-8000-000000000001",
  direction: "outbound",
  sender_type: "system",
  sender_user_id: null,
  content_type: "template",
  provider: "meta",
  structured_content: {
    templateName: "approved_menu",
    language: "he",
    parameters: [],
    openingMenuGeneration: "30000000-0000-4000-8000-000000000001",
    buttons: ["Services", "Support"],
    openingMenuOutcome: "unknown",
  },
};
describe("canonical opening-menu projection", () => {
  it.each(["sending", "sent", "failed", "unknown"])(
    "projects %s without arbitrary payload",
    (outcome) => {
      expect(
        openingMenuSummary({
          ...row,
          structured_content: {
            ...row.structured_content,
            openingMenuOutcome: outcome,
            secret: "never-forward",
          },
        }),
      ).toEqual({ outcome });
    },
  );
  it.each([
    { direction: "inbound" },
    { sender_type: "user" },
    { sender_user_id: row.id },
    { content_type: "text" },
    { provider: "simulated" },
    { id: "invalid" },
  ])("rejects noncanonical origin %j", (change) => {
    expect(openingMenuSummary({ ...row, ...change })).toBeNull();
  });
  it.each([
    { openingMenuGeneration: "other" },
    { openingMenuOutcome: "delivered" },
    { buttons: ["one"] },
    { buttons: ["<script>".repeat(10), "Support"] },
  ])("rejects invalid menu metadata %j", (change) => {
    expect(
      openingMenuSummary({
        ...row,
        structured_content: { ...row.structured_content, ...change },
      }),
    ).toBeNull();
  });
  it("preserves canonical read and delivery truth even when attempt outcome is unknown", async () => {
    const canonical = {
      ...row,
      conversation_id: row.id,
      content_text: null,
      status: "read",
      provider_message_id: "opaque",
      created_at: new Date("2026-10-04T00:00:00Z"),
      cursor_created_at: "2026-10-04T00:00:00.000000Z",
      reactions: [],
      delivery_events: [
        { status: "delivered", occurredAt: "2026-10-04T00:00:01Z" },
      ],
      outbound_error_code: null,
      outbound_diagnostic: null,
    };
    const sql = (() =>
      Promise.resolve([canonical])) as unknown as postgres.TransactionSql;
    const result = await listMessagePage(sql, row.id);
    expect(result.messages[0]?.openingMenu).toEqual({ outcome: "unknown" });
    expect(result.messages[0]?.status).toBe("read");
    expect(result.messages[0]?.deliveryEvents).toEqual(
      canonical.delivery_events,
    );
  });
});
