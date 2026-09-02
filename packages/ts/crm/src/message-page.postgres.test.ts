import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { overviewMetrics } from "./analytics.js";
import {
  ingestSimulatedInbound,
  listConversations,
  listMessagePage,
  listMessages,
} from "./messaging.js";
import type { MessageCursor } from "./types.js";

const databaseUrl = process.env.UI_TEST_DATABASE_URL;
const tenant = "10000000-0000-4000-8000-000000000001";
const otherTenant = "10000000-0000-4000-8000-000000000002";
const user = "20000000-0000-4000-8000-000000000001";
class RollbackFixture extends Error {}

describe.skipIf(databaseUrl === undefined)(
  "Inbox PostgreSQL pagination and projection",
  () => {
    it("returns the newest messages, walks microsecond cursors without gaps, and respects tenant scope", async () => {
      if (!databaseUrl) throw new Error("UI_TEST_DATABASE_URL is required");
      const destination = new URL(databaseUrl);
      if (
        !["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname) ||
        !destination.pathname.startsWith("/oron_ui_preview_")
      )
        throw new Error(
          "Use scripts/preview_ui.py --check-db with an owned fixture database",
        );
      const sql = postgres(databaseUrl, { max: 1, prepare: false });
      try {
        await expect(
          sql.begin(async (transaction) => {
            await transaction`SET LOCAL ROLE platform_web`;
            await transaction`SELECT set_config('app.current_tenant', ${tenant}, true), set_config('app.current_user', ${user}, true), set_config('app.current_role', 'owner', true)`;
            const baseline = await overviewMetrics(transaction);
            const created = await ingestSimulatedInbound(transaction, user, {
              from: "+972509999987",
              profileName: "Fictional Cursor Contact",
              text: "First fixture",
              providerEventId: "p7-page-event",
              providerMessageId: "p7-page-message",
              occurredAt: new Date("2026-01-01T00:00:00Z"),
            });
            await transaction`
          INSERT INTO messaging.messages (tenant_id, conversation_id, direction, sender_type, content_type, content_text, status, created_at)
          SELECT ${tenant}::uuid, ${created.conversationId}::uuid, 'inbound', 'contact', 'text', 'Fixture ' || sequence::text, 'received',
            '2026-01-02T00:00:00Z'::timestamptz + (sequence / 2) * interval '1 microsecond'
          FROM generate_series(1, 302) AS sequence
        `;
            const expected = await transaction<
              { id: string }[]
            >`SELECT id FROM messaging.messages WHERE conversation_id = ${created.conversationId}::uuid ORDER BY created_at, id`;
            const recent = await listMessages(
              transaction,
              created.conversationId,
            );
            expect(recent.map((message) => message.id)).toEqual(
              expected.slice(-250).map((message) => message.id),
            );
            const collected: string[] = [];
            let before: MessageCursor | undefined;
            let pageCount = 0;
            do {
              const page = await listMessagePage(
                transaction,
                created.conversationId,
                { ...(before ? { before } : {}), limit: 37 },
              );
              collected.unshift(...page.messages.map((message) => message.id));
              before = page.nextCursor ?? undefined;
              pageCount += 1;
              expect(pageCount).toBeLessThan(15);
            } while (before);
            expect(collected).toEqual(expected.map((message) => message.id));
            expect(new Set(collected).size).toBe(303);
            const conversation = (
              await listConversations(transaction, created.conversationId)
            )[0];
            expect(conversation).toMatchObject({
              provider: "simulator",
              recipientAddress: "+972509999987",
              contactName: "Fictional Cursor Contact",
            });
            expect((await overviewMetrics(transaction)).contacts).toBe(
              baseline.contacts + 1,
            );
            await transaction`SELECT set_config('app.current_tenant', ${otherTenant}, true)`;
            expect(
              (await listMessagePage(transaction, created.conversationId))
                .messages,
            ).toEqual([]);
            expect(
              await listConversations(transaction, created.conversationId),
            ).toEqual([]);
            await transaction`SELECT set_config('app.current_tenant', '', true)`;
            expect(
              (await listMessagePage(transaction, created.conversationId))
                .messages,
            ).toEqual([]);
            throw new RollbackFixture();
          }),
        ).rejects.toBeInstanceOf(RollbackFixture);
      } finally {
        await sql.end();
      }
    });
  },
);
