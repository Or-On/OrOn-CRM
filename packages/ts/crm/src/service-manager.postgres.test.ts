import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  listServiceInquiries,
  resolveServiceInquiry,
  serviceManagerMetrics,
} from "./service-manager.js";

const databaseUrl = process.env.CRM_TEST_DATABASE_URL;
class RollbackFixture extends Error {}

describe.skipIf(databaseUrl === undefined)(
  "service manager against PostgreSQL RLS",
  () => {
    it("paginates all inquiries, filters by local date, records telephone resolution and isolates tenants", async () => {
      if (databaseUrl === undefined)
        throw new Error("CRM_TEST_DATABASE_URL is required");
      if (
        !["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(databaseUrl).hostname,
        )
      )
        throw new Error(
          "Only an isolated local PostgreSQL fixture is permitted",
        );
      const database = postgres(databaseUrl, { max: 1, prepare: false });
      try {
        try {
          await database.begin(async (sql) => {
            const userId = randomUUID();
            await sql`INSERT INTO public.users(id,email,display_name,status)
          VALUES(${userId}::uuid,${`${userId}@example.invalid`},'Fictional service manager','active')`;
            const fixture = async (count: number) => {
              const tenantId = randomUUID();
              const contactId = randomUUID();
              await sql`INSERT INTO public.tenants(id,name,slug,status)
            VALUES(${tenantId}::uuid,'Fictional manager tenant',${`manager-${tenantId}`},'active')`;
              await sql`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'owner')`;
              await sql`INSERT INTO crm.contacts(id,tenant_id,name,created_by_user_id)
            VALUES(${contactId}::uuid,${tenantId}::uuid,'Fictional inquiry customer',${userId}::uuid)`;
              await sql`INSERT INTO platform.tenant_feature_entitlements(tenant_id,feature_key,available,enabled,granted_by_user_id,granted_at)
            SELECT ${tenantId}::uuid,feature,true,true,${userId}::uuid,CURRENT_TIMESTAMP
            FROM unnest(ARRAY['contacts','tickets','field_service']) feature
            ON CONFLICT(tenant_id,feature_key) DO UPDATE SET available=true,enabled=true`;
              await sql`INSERT INTO service.tenant_configuration(tenant_id,enabled) VALUES(${tenantId}::uuid,true)`;
              await sql`INSERT INTO support.tickets(tenant_id,reference,attachment_key,contact_id,subject,source_channel)
            SELECT ${tenantId}::uuid,'TEST-'||number,'manual-test:'||${tenantId}||':'||number,${contactId}::uuid,'Fictional cooling fault','manual'
            FROM generate_series(1,${count}::int) number`;
              return { tenantId, contactId };
            };
            const first = await fixture(26);
            const second = await fixture(1);
            await sql`INSERT INTO support.tickets(tenant_id,reference,attachment_key,contact_id,subject,source_channel,opened_at)
          VALUES(${first.tenantId}::uuid,'TEST-OLD',${`manual-old:${first.tenantId}`},${first.contactId}::uuid,'Historical fault','manual',
            (date_trunc('day',CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem')-interval '1 second')`;
            for (const direction of ["inbound", "outbound", "browser"]) {
              const sessionId = randomUUID();
              await sql`INSERT INTO public.sessions(session_id,tenant_id,contact_id,provider,direction,room,status,flow_id)
            VALUES(${sessionId}::uuid,${first.tenantId}::uuid,${first.contactId}::uuid,'simulator',${direction}::public.direction,
              ${`manager-call-${sessionId}`},'started',${randomUUID()}::uuid)`;
            }
            const scope = async (tenantId: string) => {
              await sql`SET LOCAL ROLE platform_web`;
              await sql`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.current_user',${userId},true),set_config('app.current_role','owner',true)`;
            };
            await scope(first.tenantId);
            const options = { timezone: "Asia/Jerusalem" };
            const firstPage = await listServiceInquiries(sql, options);
            expect(firstPage.inquiries).toHaveLength(25);
            const cursor = firstPage.nextCursor;
            if (cursor === null) throw new Error("Expected a next page");
            const lastPage = await listServiceInquiries(sql, {
              ...options,
              beforeOpenedAt: cursor.openedAt,
              beforeId: cursor.id,
            });
            expect(lastPage.inquiries).toHaveLength(2);
            expect(
              new Set(
                [...firstPage.inquiries, ...lastPage.inquiries].map(
                  (row) => row.id,
                ),
              ).size,
            ).toBe(27);
            const before = await serviceManagerMetrics(
              sql,
              options.timezone,
              "today",
            );
            expect(before.incomingCalls).toBe(1);
            expect(before.incomingMessages).toBe(0);
            expect(before.opened).toBe(26);
            expect(before.closed).toBe(0);
            const today = await listServiceInquiries(sql, {
              ...options,
              since: before.since,
              query: "Historical",
            });
            expect(today.inquiries).toHaveLength(0);
            const old = (
              await listServiceInquiries(sql, {
                ...options,
                query: "Historical",
              })
            ).inquiries[0];
            if (old === undefined)
              throw new Error("Missing historical inquiry");
            await resolveServiceInquiry(sql, userId, {
              ticketId: old.id,
              method: "telephone",
              confirmation: "customer",
              summary: "Fictional customer confirmed cooling restored",
            });
            const closed = await listServiceInquiries(sql, {
              ...options,
              status: "telephone",
            });
            expect(closed.inquiries.map((row) => row.id)).toEqual([old.id]);
            const after = await serviceManagerMetrics(
              sql,
              options.timezone,
              "today",
            );
            expect(after.closed).toBe(1);
            expect(after.opened).toBe(26);
            await scope(second.tenantId);
            expect(
              (await listServiceInquiries(sql, options)).inquiries,
            ).toHaveLength(1);
            expect(
              (await listServiceInquiries(sql, { ...options, id: old.id }))
                .inquiries,
            ).toHaveLength(0);
            const isolated = await serviceManagerMetrics(
              sql,
              options.timezone,
              "today",
            );
            expect(isolated.incomingCalls).toBe(0);
            expect(isolated.closed).toBe(0);
            throw new RollbackFixture();
          });
        } catch (error) {
          if (!(error instanceof RollbackFixture)) throw error;
        }
      } finally {
        await database.end({ timeout: 2 });
      }
    });
  },
);
