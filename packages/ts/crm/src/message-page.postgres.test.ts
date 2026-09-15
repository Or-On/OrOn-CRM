import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { overviewMetrics } from "./analytics.js";
import { createAutomationDraft, listAutomations } from "./automations.js";
import {
  ingestSimulatedInbound,
  listConversationPage,
  listConversations,
  listMessagePage,
  listMessages,
} from "./messaging.js";
import type { ConversationCursor, MessageCursor } from "./types.js";

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
            const automationId = await createAutomationDraft(
              transaction,
              user,
              "Fictional presentation adapter",
            );
            expect(
              (await listAutomations(transaction)).find(
                (item) => item.id === automationId,
              )?.executionKind,
            ).toBe("empty");
            await transaction`UPDATE automation.flow_versions SET definition = '{"schemaVersion":"1.0","nodes":[{"id":"fixture"}]}'::jsonb WHERE flow_definition_id = ${automationId}::uuid`;
            expect(
              (await listAutomations(transaction)).find(
                (item) => item.id === automationId,
              )?.executionKind,
            ).toBe("canonical");
            await transaction`UPDATE automation.flow_versions SET definition = '{"nodes":[{"id":"fixture"}]}'::jsonb WHERE flow_definition_id = ${automationId}::uuid`;
            expect(
              (await listAutomations(transaction)).find(
                (item) => item.id === automationId,
              )?.executionKind,
            ).toBe("unsupported");
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
            const paginationPrefix = `Fictional Inbox Pagination ${randomUUID()}`;
            await transaction`
              INSERT INTO crm.contacts
                (tenant_id, created_by_user_id, name)
              SELECT ${tenant}::uuid, ${user}::uuid,
                     ${paginationPrefix} || ' ' || lpad(sequence::text, 4, '0')
              FROM generate_series(1, 105) AS sequence
            `;
            await transaction`
              INSERT INTO messaging.conversations
                (tenant_id, channel_id, contact_id, status, unread_count,
                 last_message_at, last_message_preview)
              SELECT ${tenant}::uuid, source.channel_id, contact.id, 'open',
                     CASE WHEN right(contact.name, 1) = '0' THEN 1 ELSE 0 END,
                     '2026-02-01T00:00:00Z'::timestamptz
                       + right(contact.name, 4)::integer * interval '1 microsecond',
                     'Pagination fixture'
              FROM crm.contacts contact
              CROSS JOIN (
                SELECT channel_id FROM messaging.conversations
                WHERE id = ${created.conversationId}::uuid
              ) source
              WHERE contact.name LIKE ${`${paginationPrefix}%`}
            `;
            const paginatedConversationIds: string[] = [];
            let conversationCursor: ConversationCursor | undefined;
            do {
              const page = await listConversationPage(transaction, {
                query: paginationPrefix,
                limit: 37,
                ...(conversationCursor === undefined
                  ? {}
                  : { before: conversationCursor }),
              });
              paginatedConversationIds.push(
                ...page.conversations.map((conversation) => conversation.id),
              );
              conversationCursor = page.nextCursor ?? undefined;
            } while (conversationCursor !== undefined);
            expect(paginatedConversationIds).toHaveLength(105);
            expect(new Set(paginatedConversationIds).size).toBe(105);
            expect(
              (
                await listConversationPage(transaction, {
                  query: `${paginationPrefix} 0105`,
                })
              ).conversations,
            ).toHaveLength(1);
            expect(
              (
                await listConversationPage(transaction, {
                  query: paginationPrefix,
                  filter: "unread",
                  currentUserId: user,
                })
              ).conversations,
            ).toHaveLength(10);
            await transaction`SELECT set_config('app.current_tenant', ${otherTenant}, true)`;
            expect(
              (await listMessagePage(transaction, created.conversationId))
                .messages,
            ).toEqual([]);
            expect(
              await listConversations(transaction, created.conversationId),
            ).toEqual([]);
            expect(
              (
                await listConversationPage(transaction, {
                  query: paginationPrefix,
                })
              ).conversations,
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
