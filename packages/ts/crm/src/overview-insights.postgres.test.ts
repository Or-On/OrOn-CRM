import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { overviewInsights, tenantOperationalInsights } from "./analytics.js";
import { ingestSimulatedInbound } from "./messaging.js";

const databaseUrl = process.env.UI_TEST_DATABASE_URL;
class RollbackFixture extends Error {}

describe.skipIf(!databaseUrl)(
  "Overview tenant-scoped recorded activity",
  () => {
    it("uses 14 UTC days, excludes out-of-range rows and cannot read another tenant", async () => {
      if (!databaseUrl)
        throw new Error("Use the isolated UI PostgreSQL preview test runner");
      const target = new URL(databaseUrl);
      if (
        !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
        !/^\/oron_ui_preview_[a-f0-9]+$/.test(target.pathname)
      )
        throw new Error("Only owned fictional databases are permitted");
      const sql = postgres(databaseUrl, { max: 1, prepare: false });
      const tenant = "10000000-0000-4000-8000-000000000001";
      const user = "20000000-0000-4000-8000-000000000001";
      try {
        await expect(
          sql.begin(async (transaction) => {
            await transaction`SET LOCAL ROLE platform_web`;
            await transaction`SELECT set_config('app.current_tenant', ${tenant}, true), set_config('app.current_user', ${user}, true), set_config('app.current_role', 'owner', true)`;
            const before = await overviewInsights(transaction);
            const monthlyBefore = await tenantOperationalInsights(transaction);
            const conversation = await ingestSimulatedInbound(
              transaction,
              user,
              {
                from: "+12025550198",
                profileName: "Fictional Activity Test",
                text: "Recorded locally",
                providerEventId: "overview-activity-event",
                providerMessageId: "overview-activity-message",
              },
            );
            await transaction`
          INSERT INTO messaging.messages(tenant_id, conversation_id, direction, sender_type, content_type, content_text, status, created_at)
          VALUES (${tenant}::uuid, ${conversation.conversationId}::uuid, 'outbound', 'system', 'text', 'Fictional inclusive boundary', 'sent', (((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 13)::timestamp AT TIME ZONE 'UTC')),
                 (${tenant}::uuid, ${conversation.conversationId}::uuid, 'outbound', 'system', 'text', 'Fictional excluded boundary', 'sent', (((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 13)::timestamp AT TIME ZONE 'UTC') - interval '1 second')
        `;
            const after = await overviewInsights(transaction);
            const monthlyAfter = await tenantOperationalInsights(transaction);
            expect(monthlyAfter.inbound).toBe(monthlyBefore.inbound + 1);
            expect(monthlyAfter.outbound).toBeGreaterThanOrEqual(
              monthlyBefore.outbound,
            );
            expect(
              monthlyAfter.delivered +
                monthlyAfter.failed +
                monthlyAfter.awaiting,
            ).toBe(monthlyAfter.outbound);
            expect(Number.isFinite(Date.parse(monthlyAfter.checkedAt))).toBe(
              true,
            );
            expect(monthlyAfter.monthStart).toMatch(/^\d{4}-\d{2}-01$/);
            const sum = (value: typeof after) =>
              value.dailyMessages.reduce(
                (total, day) => total + day.inbound + day.outbound,
                0,
              );
            expect(after.dailyMessages).toHaveLength(14);
            expect(
              new Set(after.dailyMessages.map((day) => day.day)).size,
            ).toBe(14);
            expect(after.dailyMessages.map((day) => day.day)).toEqual(
              after.dailyMessages.map((day) => day.day).toSorted(),
            );
            expect(sum(after) - sum(before)).toBe(2);
            expect(after.dailyMessages[0]?.outbound).toBe(
              (before.dailyMessages[0]?.outbound ?? 0) + 1,
            );
            expect(
              after.conversationStates.reduce(
                (total, state) => total + state.count,
                0,
              ),
            ).toBe(
              before.conversationStates.reduce(
                (total, state) => total + state.count,
                0,
              ) + 1,
            );
            await transaction`
              INSERT INTO messaging.messages(tenant_id, conversation_id, direction, sender_type, content_type, content_text, status, created_at)
              SELECT ${tenant}::uuid, ${conversation.conversationId}::uuid, 'outbound', 'system', 'text', 'Fictional monthly outcome', bucket, CURRENT_TIMESTAMP
              FROM unnest(ARRAY['delivered', 'read', 'failed', 'sent']) AS bucket
            `;
            await transaction`
              INSERT INTO messaging.messages(tenant_id, conversation_id, direction, sender_type, content_type, content_text, status, created_at)
              VALUES (${tenant}::uuid, ${conversation.conversationId}::uuid, 'outbound', 'system', 'text', 'Fictional previous month', 'delivered',
                (date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '1 second'),
                (${tenant}::uuid, ${conversation.conversationId}::uuid, 'outbound', 'system', 'text', 'Fictional future record', 'delivered', CURRENT_TIMESTAMP + interval '1 day')
            `;
            const outcomes = await tenantOperationalInsights(transaction);
            expect(outcomes.outbound).toBe(monthlyAfter.outbound + 4);
            expect(outcomes.delivered).toBe(monthlyAfter.delivered + 2);
            expect(outcomes.failed).toBe(monthlyAfter.failed + 1);
            expect(outcomes.awaiting).toBe(monthlyAfter.awaiting + 1);
            expect(outcomes.contactsReached).toBe(
              monthlyAfter.contactsReached + 1,
            );
            await transaction`SELECT set_config('app.current_tenant', '10000000-0000-4000-8000-000000000002', true)`;
            const isolated = await overviewInsights(transaction);
            expect(sum(isolated)).toBe(0);
            expect(isolated.conversationStates).toEqual([]);
            const isolatedMonthly =
              await tenantOperationalInsights(transaction);
            for (const [key, value] of Object.entries(isolatedMonthly)) {
              if (key !== "monthStart" && key !== "checkedAt")
                expect(value).toBe(0);
            }
            throw new RollbackFixture();
          }),
        ).rejects.toBeInstanceOf(RollbackFixture);
      } finally {
        await sql.end();
      }
    });
  },
);
