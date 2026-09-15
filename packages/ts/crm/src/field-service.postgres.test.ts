import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  approveAppointmentSuggestion,
  archiveServiceLocation,
  createServiceCase,
  createServiceLocation,
  createServiceVisit,
  getServiceCaseDossier,
  linkCaseCall,
  linkCaseConversation,
  listServiceCaseLinkCandidates,
  rescheduleServiceAppointment,
  scheduleServiceAppointment,
  suggestNextServiceAppointment,
} from "./field-service.js";

const databaseUrl = process.env.CRM_TEST_DATABASE_URL;

class RollbackFixture extends Error {}

async function isolated(
  work: (
    sql: postgres.TransactionSql,
    fixture: {
      readonly tenantId: string;
      readonly userId: string;
      readonly contactId: string;
      readonly caseId: string;
      readonly technicianId: string;
    },
  ) => Promise<void>,
) {
  if (databaseUrl === undefined)
    throw new Error("CRM_TEST_DATABASE_URL is required");
  const target = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname))
    throw new Error("Only an isolated local PostgreSQL fixture is permitted");
  const database = postgres(databaseUrl, { max: 1, prepare: false });
  const tenantId = randomUUID();
  try {
    await expect(
      database.begin(async (sql) => {
        const userId = randomUUID();
        const technicianUserId = randomUUID();
        const contactId = randomUUID();
        await sql`
          INSERT INTO public.tenants(id,name,slug,status)
          VALUES(${tenantId}::uuid,'Fictional field service tenant',
                 ${`field-service-${tenantId}`} ,'active')
        `;
        await sql`
          INSERT INTO public.users(id,email,display_name,status) VALUES
            (${userId}::uuid,${`${userId}@example.invalid`},
             'Fictional field-service owner','active'),
            (${technicianUserId}::uuid,${`${technicianUserId}@example.invalid`},
             'Fictional field-service technician','active')
        `;
        await sql`
          INSERT INTO public.memberships(tenant_id,user_id,role) VALUES
            (${tenantId}::uuid,${userId}::uuid,'owner'),
            (${tenantId}::uuid,${technicianUserId}::uuid,'technician')
        `;
        await sql`
          INSERT INTO crm.tenant_settings(
            tenant_id,display_name,default_currency,locale,timezone
          ) VALUES(
            ${tenantId}::uuid,'Fictional field service tenant','USD','en','UTC'
          )
        `;
        await sql`
          INSERT INTO crm.contacts(id,tenant_id,name,created_by_user_id)
          VALUES(${contactId}::uuid,${tenantId}::uuid,
                 'Fictional scheduling customer',${userId}::uuid)
        `;
        await sql`
          INSERT INTO platform.tenant_feature_entitlements(
            tenant_id,feature_key,available,granted_by_user_id,granted_at
          ) VALUES(
            ${tenantId}::uuid,'field_service',true,${userId}::uuid,CURRENT_TIMESTAMP
          )
        `;
        await sql`
          INSERT INTO service.tenant_configuration(
            tenant_id,enabled,ai_scheduling_enabled,
            ai_schedule_requires_approval,calendar_access,calendar_provider
          ) VALUES(
            ${tenantId}::uuid,true,true,true,'read_only','crm_calendar'
          )
        `;
        const technicians = await sql<{ id: string }[]>`
          INSERT INTO service.technicians(
            tenant_id,linked_user_id,employee_identifier,full_name,
            created_by_user_id
          ) VALUES(
            ${tenantId}::uuid,${technicianUserId}::uuid,'SCHEDULE-01',
            'Fictional Scheduling Technician',${userId}::uuid
          ) RETURNING id
        `;
        const technicianId = technicians[0]?.id;
        if (technicianId === undefined)
          throw new Error("Technician fixture was not created");
        const cases = await sql<{ id: string }[]>`
          INSERT INTO service.cases(
            tenant_id,reference,customer_contact_id,title,fault_description,
            created_by_user_id
          ) VALUES(
            ${tenantId}::uuid,'FS-SCHEDULE-APP',${contactId}::uuid,
            'Fictional scheduling case','Synthetic scheduling evidence',
            ${userId}::uuid
          ) RETURNING id
        `;
        const caseId = cases[0]?.id;
        if (caseId === undefined)
          throw new Error("Case fixture was not created");
        await sql`SET LOCAL ROLE platform_web`;
        await sql`
          SELECT set_config('app.current_tenant',${tenantId},true),
                 set_config('app.current_user',${userId},true),
                 set_config('app.current_role','owner',true)
        `;
        await work(sql, {
          tenantId,
          userId,
          contactId,
          caseId,
          technicianId,
        });
        throw new RollbackFixture();
      }),
    ).rejects.toBeInstanceOf(RollbackFixture);
  } finally {
    await database.end({ timeout: 2 });
  }
}

describe.skipIf(databaseUrl === undefined)(
  "field-service scheduling against PostgreSQL RLS",
  () => {
    it("keeps read-only AI suggestions unbooked while manual scheduling remains available", async () =>
      isolated(async (sql, fixture) => {
        const groundedSuggestion = await suggestNextServiceAppointment(
          sql,
          fixture.userId,
          {
            caseId: fixture.caseId,
            earliestAt: new Date(
              Date.now() + 24 * 60 * 60 * 1_000,
            ).toISOString(),
            durationMinutes: 60,
            timezone: "UTC",
            idempotencyKey: "field-service-grounded-suggestion",
          },
        );
        expect(groundedSuggestion).toMatchObject({
          source: "ai_suggestion",
          status: "suggested",
          approvalStatus: "pending",
          externalEventId: null,
        });
        const suggestion = await scheduleServiceAppointment(
          sql,
          fixture.userId,
          {
            caseId: fixture.caseId,
            technicianId: fixture.technicianId,
            startsAt: "2026-10-01T08:00:00.000Z",
            endsAt: "2026-10-01T09:00:00.000Z",
            timezone: "UTC",
            source: "ai_suggestion",
            idempotencyKey: "field-service-read-only-suggestion",
          },
        );
        expect(suggestion).toMatchObject({
          status: "suggested",
          approvalStatus: "pending",
          externalEventId: null,
        });
        await expect(
          approveAppointmentSuggestion(sql, fixture.userId, suggestion.id),
        ).rejects.toThrow(/write access/u);

        const manual = await scheduleServiceAppointment(sql, fixture.userId, {
          caseId: fixture.caseId,
          technicianId: fixture.technicianId,
          startsAt: "2026-10-01T10:00:00.000Z",
          endsAt: "2026-10-01T11:00:00.000Z",
          timezone: "UTC",
          source: "manual",
          idempotencyKey: "field-service-manual-appointment",
        });
        expect(manual).toMatchObject({
          status: "scheduled",
          approvalStatus: "approved",
          externalEventId: null,
        });
        await sql`SELECT set_config('app.current_role','technician',true)`;
        await expect(
          createServiceVisit(
            sql,
            fixture.userId,
            fixture.caseId,
            fixture.technicianId,
          ),
        ).rejects.toThrow(/matching scheduled appointment/u);
        await sql`SELECT set_config('app.current_role','owner',true)`;
        const visit = await createServiceVisit(
          sql,
          fixture.userId,
          fixture.caseId,
          fixture.technicianId,
          manual.id,
        );
        expect(visit.appointmentId).toBe(manual.id);
        const calendarEvents = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM crm.calendar_events
          WHERE tenant_id=${fixture.tenantId}::uuid
        `;
        expect(calendarEvents[0]?.count).toBe(0);
      }));

    it("includes only explicitly linked conversations and calls and reports missing media honestly", async () =>
      isolated(async (sql, fixture) => {
        const channelId = randomUUID();
        const unrelatedChannelId = randomUUID();
        const conversationId = randomUUID();
        const unrelatedConversationId = randomUUID();
        const sessionId = randomUUID();
        const unrelatedSessionId = randomUUID();
        const crossChannelSessionId = randomUUID();
        await sql`
          INSERT INTO messaging.channels(
            id, tenant_id, kind, provider, provider_account_id, status
          ) VALUES
          (
            ${channelId}::uuid, ${fixture.tenantId}::uuid, 'whatsapp',
            'simulator', ${`field-service-${fixture.tenantId}`}, 'active'
          ),
          (
            ${unrelatedChannelId}::uuid, ${fixture.tenantId}::uuid, 'whatsapp',
            'simulator', ${`field-service-other-${fixture.tenantId}`}, 'active'
          )
        `;
        await sql`
          INSERT INTO messaging.conversations(
            id, tenant_id, channel_id, contact_id, status
          ) VALUES
            (${conversationId}::uuid, ${fixture.tenantId}::uuid,
             ${channelId}::uuid, ${fixture.contactId}::uuid, 'open'),
            (${unrelatedConversationId}::uuid, ${fixture.tenantId}::uuid,
             ${unrelatedChannelId}::uuid, ${fixture.contactId}::uuid, 'open')
        `;
        await sql`
          INSERT INTO messaging.messages(
            tenant_id, conversation_id, direction, sender_type, content_type,
            content_text, provider, status
          ) VALUES(
            ${fixture.tenantId}::uuid, ${conversationId}::uuid, 'inbound',
            'contact', 'text', 'Synthetic linked evidence', 'simulator', 'received'
          )
        `;
        // Voice-session writes belong to the voice runtime, not platform_web.
        // Arrange retained call evidence as the fixture owner, then return to
        // the exact role used by the case-detail page for the assertions.
        await sql`RESET ROLE`;
        await sql`
          INSERT INTO public.sessions(
            session_id, tenant_id, contact_id, provider, direction, room,
            status, outcome, flow_id
          ) VALUES
            (${sessionId}::uuid, ${fixture.tenantId}::uuid,
             ${fixture.contactId}::uuid, 'simulator', 'outbound',
             ${`field-service-${sessionId}`}, 'ended', 'completed',
             ${randomUUID()}::uuid),
            (${unrelatedSessionId}::uuid, ${fixture.tenantId}::uuid,
             ${fixture.contactId}::uuid, 'simulator', 'outbound',
             ${`field-service-${unrelatedSessionId}`}, 'ended', 'completed',
             ${randomUUID()}::uuid),
            (${crossChannelSessionId}::uuid, ${fixture.tenantId}::uuid,
             NULL, 'simulator', 'outbound',
             ${`field-service-${crossChannelSessionId}`}, 'ended', 'completed',
             ${randomUUID()}::uuid)
        `;
        await sql`
          INSERT INTO public.session_events(
            tenant_id, session_id, sequence, event_type, payload
          ) VALUES(
            ${fixture.tenantId}::uuid, ${crossChannelSessionId}::uuid, 0,
            'voice.call.admission.v1',
            ${sql.json({ source_conversation_id: conversationId })}
          )
        `;

        await sql`SET LOCAL ROLE platform_web`;
        const candidates = await listServiceCaseLinkCandidates(
          sql,
          fixture.caseId,
        );
        expect(candidates.calls).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sessionId,
              linked: false,
            }),
            expect.objectContaining({
              sessionId: unrelatedSessionId,
              linked: false,
            }),
            expect.objectContaining({
              sessionId: crossChannelSessionId,
              linked: false,
            }),
          ]),
        );

        await linkCaseConversation(
          sql,
          fixture.caseId,
          conversationId,
          "relevant",
          fixture.userId,
        );
        await linkCaseCall(
          sql,
          fixture.userId,
          fixture.caseId,
          crossChannelSessionId,
          "diagnostic",
        );
        const dossier = await getServiceCaseDossier(sql, fixture.caseId);

        expect(dossier?.conversationIds).toEqual([conversationId]);
        expect(dossier?.conversations[0]?.messages[0]?.contentText).toBe(
          "Synthetic linked evidence",
        );
        expect(dossier?.callSessionIds).toEqual([crossChannelSessionId]);
        expect(dossier?.calls).toEqual([
          expect.objectContaining({
            sessionId: crossChannelSessionId,
            recordingObjectId: null,
            transcriptObjectId: null,
            recordingStatus: "missing",
            transcriptStatus: "missing",
          }),
        ]);
        expect(dossier?.conversationIds).not.toContain(unrelatedConversationId);
        expect(dossier?.callSessionIds).not.toContain(unrelatedSessionId);
        expect(dossier?.callSessionIds).not.toContain(sessionId);
      }));

    it("rejects archived or wrong-customer locations when creating a case", async () =>
      isolated(async (sql, fixture) => {
        const locationId = await createServiceLocation(sql, {
          customerContactId: fixture.contactId,
          name: "Fictional archived location",
        });
        expect(
          await archiveServiceLocation(
            sql,
            fixture.userId,
            fixture.contactId,
            locationId,
          ),
        ).toBe(true);

        await expect(
          createServiceCase(
            sql,
            { userId: fixture.userId },
            {
              customerContactId: fixture.contactId,
              serviceLocationId: locationId,
              title: "Fictional archived location case",
              faultDescription: "Synthetic fault details for validation",
            },
          ),
        ).rejects.toThrow(/active service location belonging to the customer/u);
      }));

    it("makes scheduling idempotent, blocks inactive assignees, and supports reassignment", async () =>
      isolated(async (sql, fixture) => {
        const input = {
          caseId: fixture.caseId,
          technicianId: fixture.technicianId,
          startsAt: "2026-10-02T08:00:00.000Z",
          endsAt: "2026-10-02T09:00:00.000Z",
          timezone: "UTC",
          notes: "Synthetic first visit",
          source: "manual" as const,
          idempotencyKey: "field-service-idempotent-schedule",
        };
        const scheduled = await scheduleServiceAppointment(
          sql,
          fixture.userId,
          input,
        );
        expect(
          await scheduleServiceAppointment(sql, fixture.userId, input),
        ).toEqual(scheduled);
        await expect(
          scheduleServiceAppointment(sql, fixture.userId, {
            ...input,
            notes: "Changed payload must not reuse the key",
          }),
        ).rejects.toThrow(/idempotency key/u);

        const replacementRows = await sql<{ id: string }[]>`
          INSERT INTO service.technicians(
            tenant_id, employee_identifier, full_name, created_by_user_id
          ) VALUES(
            ${fixture.tenantId}::uuid, 'SCHEDULE-02',
            'Fictional Replacement Technician', ${fixture.userId}::uuid
          ) RETURNING id
        `;
        const replacementId = replacementRows[0]?.id;
        if (replacementId === undefined)
          throw new Error("Replacement technician fixture was not created");
        const reassigned = await rescheduleServiceAppointment(
          sql,
          fixture.userId,
          scheduled.id,
          {
            technicianId: replacementId,
            startsAt: "2026-10-02T10:00:00.000Z",
            endsAt: "2026-10-02T11:00:00.000Z",
            timezone: "UTC",
            notes: "Synthetic reassignment",
            idempotencyKey: "field-service-reassignment",
          },
        );
        expect(reassigned.technicianId).toBe(replacementId);

        await sql`
          UPDATE service.technicians SET active=false
          WHERE id=${replacementId}::uuid
        `;
        expect(
          await rescheduleServiceAppointment(
            sql,
            fixture.userId,
            scheduled.id,
            {
              technicianId: replacementId,
              startsAt: "2026-10-02T10:00:00.000Z",
              endsAt: "2026-10-02T11:00:00.000Z",
              timezone: "UTC",
              notes: "Synthetic reassignment",
              idempotencyKey: "field-service-reassignment",
            },
          ),
        ).toEqual(reassigned);
        await expect(
          scheduleServiceAppointment(sql, fixture.userId, {
            ...input,
            technicianId: replacementId,
            startsAt: "2026-10-03T08:00:00.000Z",
            endsAt: "2026-10-03T09:00:00.000Z",
            idempotencyKey: "field-service-inactive-technician",
          }),
        ).rejects.toThrow(/active technician/u);
      }));
  },
);
