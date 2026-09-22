import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  createTechnicianServiceCase,
  finalizeReportRevision,
  getServiceCaseDossier,
  getServiceReportDocument,
  listServiceReportPage,
  openReportDraft,
  saveReportDraft,
  ServiceReportNotFoundError,
} from "./field-service.js";
import {
  bindTechnicianSession,
  getTechnicianSessionContext,
  listTechnicianSessionCandidates,
  releaseTechnicianSession,
} from "./field-service-session.js";
import { listServiceQueue } from "./service-workflow.js";

const databaseUrl = process.env.CRM_TEST_DATABASE_URL;

class RollbackFixture extends Error {}

interface Fixture {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly sharedUserId: string;
  readonly contactId: string;
  readonly david: string;
  readonly moshe: string;
  readonly tabletA: string;
  readonly tabletB: string;
}

type Actor = "owner" | "tabletA" | "tabletB";

async function scenario(
  work: (
    sql: postgres.TransactionSql,
    fixture: Fixture,
    as: (actor: Actor) => Promise<void>,
  ) => Promise<void>,
) {
  if (databaseUrl === undefined)
    throw new Error("CRM_TEST_DATABASE_URL is required");
  const target = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname))
    throw new Error("Only an isolated local PostgreSQL fixture is permitted");
  const database = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await expect(
      database.begin(async (sql) => {
        const tenantId = randomUUID();
        const ownerId = randomUUID();
        const sharedUserId = randomUUID();
        const contactId = randomUUID();
        await sql`
          INSERT INTO public.tenants(id,name,slug,status)
          VALUES(${tenantId}::uuid,'Fictional shared technician tenant',
                 ${`shared-technicians-${tenantId}`},'active')
        `;
        await sql`
          INSERT INTO public.users(id,email,display_name,status) VALUES
            (${ownerId}::uuid,${`${ownerId}@example.invalid`},'Fictional manager','active'),
            (${sharedUserId}::uuid,${`${sharedUserId}@example.invalid`},
             'Shared technician account','active')
        `;
        await sql`
          INSERT INTO public.memberships(tenant_id,user_id,role) VALUES
            (${tenantId}::uuid,${ownerId}::uuid,'owner'),
            (${tenantId}::uuid,${sharedUserId}::uuid,'technician')
        `;
        await sql`
          INSERT INTO crm.tenant_settings(
            tenant_id,display_name,default_currency,locale,timezone
          ) VALUES(${tenantId}::uuid,'Fictional shared technician tenant','USD','en','UTC')
        `;
        await sql`
          INSERT INTO crm.contacts(id,tenant_id,name,created_by_user_id)
          VALUES(${contactId}::uuid,${tenantId}::uuid,'Fictional field customer',${ownerId}::uuid)
        `;
        await sql`
          INSERT INTO platform.tenant_feature_entitlements(
            tenant_id,feature_key,available,granted_by_user_id,granted_at,configuration
          ) VALUES(
            ${tenantId}::uuid,'field_service',true,${ownerId}::uuid,CURRENT_TIMESTAMP,
            ${sql.json({
              workflow: {
                version: 1,
                requiredIntakeFields: ["faultDescription"],
                photoPolicy: "optional",
                selfAssignmentEnabled: true,
                requiredReportFields: ["diagnosis", "workPerformed"],
              },
            })}
          )
        `;
        await sql`
          INSERT INTO service.tenant_configuration(
            tenant_id,enabled,shared_technician_login_enabled
          ) VALUES(${tenantId}::uuid,true,true)
        `;
        const technicians = await sql<{ id: string; full_name: string }[]>`
          INSERT INTO service.technicians(
            tenant_id,full_name,employee_identifier,created_by_user_id
          ) VALUES
            (${tenantId}::uuid,'David Fixture','FS-DAVID',${ownerId}::uuid),
            (${tenantId}::uuid,'Moshe Fixture','FS-MOSHE',${ownerId}::uuid)
          RETURNING id, full_name
        `;
        const session = async (label: string) => {
          const rows = await sql<{ id: string }[]>`
            SELECT platform.auth_create_session(
              ${sharedUserId}::uuid, ${tenantId}::uuid,
              ${Buffer.from(randomUUID() + randomUUID())}::bytea,
              ${Buffer.from(randomUUID() + randomUUID())}::bytea, 43200,
              CURRENT_TIMESTAMP + interval '12 hours',
              CURRENT_TIMESTAMP + interval '7 days', NULL, NULL, ${label}
            ) AS id
          `;
          const id = rows[0]?.id;
          if (id === undefined) throw new Error("session fixture failed");
          return id;
        };
        const fixture: Fixture = {
          tenantId,
          ownerId,
          sharedUserId,
          contactId,
          david:
            technicians.find((row) => row.full_name === "David Fixture")?.id ??
            "",
          moshe:
            technicians.find((row) => row.full_name === "Moshe Fixture")?.id ??
            "",
          tabletA: await session("tablet-a"),
          tabletB: await session("tablet-b"),
        };
        const as = async (actor: Actor) => {
          await sql`SET LOCAL ROLE platform_web`;
          await sql`
            SELECT set_config('app.current_tenant',${tenantId},true),
                   set_config('app.current_user',
                     ${actor === "owner" ? ownerId : sharedUserId},true),
                   set_config('app.current_role',
                     ${actor === "owner" ? "owner" : "technician"},true),
                   set_config('app.current_session',
                     ${actor === "owner" ? "" : fixture[actor]},true)
          `;
        };
        await work(sql, fixture, as);
        throw new RollbackFixture();
      }),
    ).rejects.toBeInstanceOf(RollbackFixture);
  } finally {
    await database.end({ timeout: 2 });
  }
}

describe.skipIf(databaseUrl === undefined)(
  "shared technician account field work (PostgreSQL)",
  () => {
    it("attributes case, visit and report work to each session's technician and keeps reports tenant-owned", async () =>
      scenario(async (sql, fixture, as) => {
        await as("tabletA");
        expect(await getTechnicianSessionContext(sql)).toEqual({
          mode: "shared",
          technician: null,
        });
        await expect(
          sql.savepoint((inner) => listServiceQueue(inner, "mine")),
        ).rejects.toMatchObject({ code: "FS428" });
        expect(
          (await listTechnicianSessionCandidates(sql)).map(
            (item) => item.fullName,
          ),
        ).toEqual(["David Fixture", "Moshe Fixture"]);
        await expect(
          sql.savepoint((inner) =>
            bindTechnicianSession(inner, {
              technicianId: fixture.david,
              employeeIdentifier: "wrong",
            }),
          ),
        ).rejects.toMatchObject({ code: "FS401" });
        const david = await bindTechnicianSession(sql, {
          technicianId: fixture.david,
          employeeIdentifier: "FS-DAVID",
        });
        expect(david.fullName).toBe("David Fixture");

        const davidCase = await createTechnicianServiceCase(sql, {
          customerContactId: fixture.contactId,
          title: "Checkout printer is blank",
          faultDescription: "Receipts print blank",
          exactFailure: "Only the header prints",
          productModel: "Fictional printer",
          requestId: "tablet-a-create",
        });
        expect(davidCase.technicianId).toBe(fixture.david);
        expect(davidCase.serviceCase.reference).toMatch(/^FS-\d{4}-/u);
        expect(davidCase.serviceCase.faultDescription).toBe(
          "Receipts print blank\nOnly the header prints",
        );
        expect(
          (await listServiceQueue(sql, "mine")).items.map((item) => item.id),
        ).toEqual([davidCase.serviceCase.id]);
        const dossier = await getServiceCaseDossier(
          sql,
          davidCase.serviceCase.id,
        );
        expect(dossier?.visits.map((visit) => visit.technicianId)).toEqual([
          fixture.david,
        ]);

        const draft = await openReportDraft(
          sql,
          fixture.sharedUserId,
          davidCase.serviceCase.id,
          davidCase.visitId,
          "tablet-a-open-report",
        );
        await saveReportDraft(sql, fixture.sharedUserId, draft.id, {
          diagnosis: "Worn print head",
          workPerformed: "Replaced the print head",
          partReplaced: true,
          replacementPartDetails: "Fictional print head",
        });
        const finalized = await finalizeReportRevision(
          sql,
          fixture.sharedUserId,
          draft.id,
          "tablet-a-finalize",
        );
        expect(finalized.status).toBe("finalized");

        // Tablet B is the same platform user but another physical technician.
        await as("tabletB");
        expect((await getTechnicianSessionContext(sql)).technician).toBeNull();
        await bindTechnicianSession(sql, {
          technicianId: fixture.moshe,
          employeeIdentifier: "FS-MOSHE",
        });
        expect(
          await getServiceCaseDossier(sql, davidCase.serviceCase.id),
        ).toBeUndefined();
        await expect(
          sql.savepoint((inner) =>
            saveReportDraft(inner, fixture.sharedUserId, draft.id, {
              diagnosis: "Overwritten by another technician",
            }),
          ),
        ).rejects.toThrow(/Editable report revision was not found/u);
        await expect(
          sql.savepoint((inner) =>
            openReportDraft(
              inner,
              fixture.sharedUserId,
              davidCase.serviceCase.id,
              davidCase.visitId,
            ),
          ),
        ).rejects.toBeInstanceOf(ServiceReportNotFoundError);
        const mosheCase = await createTechnicianServiceCase(sql, {
          customerContactId: fixture.contactId,
          title: "Scale does not tare",
          faultDescription: "Scale drifts after tare",
          requestId: "tablet-b-create",
        });
        expect(mosheCase.technicianId).toBe(fixture.moshe);
        const mosheDraft = await openReportDraft(
          sql,
          fixture.sharedUserId,
          mosheCase.serviceCase.id,
          mosheCase.visitId,
        );
        await saveReportDraft(sql, fixture.sharedUserId, mosheDraft.id, {
          diagnosis: "Loose load cell",
        });
        expect(
          (await listServiceReportPage(sql)).reports.map(
            (report) => report.technicianName,
          ),
        ).toEqual(["Moshe Fixture"]);

        // Tablet A's own identity is unchanged by tablet B's work.
        await as("tabletA");
        expect((await getTechnicianSessionContext(sql)).technician?.id).toBe(
          fixture.david,
        );

        // Logging tablet A out does not remove the tenant's report.
        await sql`RESET ROLE`;
        await sql`
          UPDATE platform.auth_sessions
          SET revoked_at=clock_timestamp(), revocation_reason='user_logout'
          WHERE id=${fixture.tabletA}::uuid
        `;
        await as("tabletA");
        expect((await getTechnicianSessionContext(sql)).technician).toBeNull();
        await as("tabletB");
        expect(await releaseTechnicianSession(sql, "tablet-b-handover")).toBe(
          true,
        );

        await as("owner");
        const registry = await listServiceReportPage(sql);
        expect(
          registry.reports.map((report) => ({
            reference: report.caseReference,
            technician: report.technicianName,
            status: report.status,
          })),
        ).toEqual(
          expect.arrayContaining([
            {
              reference: davidCase.serviceCase.reference,
              technician: "David Fixture",
              status: "finalized",
            },
            {
              reference: mosheCase.serviceCase.reference,
              technician: "Moshe Fixture",
              status: "draft",
            },
          ]),
        );
        const stored = await sql<
          { tenant_id: string; revisions: number; technician: string }[]
        >`
          SELECT report.tenant_id, count(revision.id)::int AS revisions,
                 technician.full_name AS technician
          FROM service.reports report
          JOIN service.report_revisions revision ON revision.report_id=report.id
          JOIN service.visits visit ON visit.id=report.visit_id
          JOIN service.technicians technician ON technician.id=visit.technician_id
          WHERE report.case_id=${davidCase.serviceCase.id}::uuid
          GROUP BY report.tenant_id, technician.full_name
        `;
        expect(stored).toEqual([
          {
            tenant_id: fixture.tenantId,
            revisions: 1,
            technician: "David Fixture",
          },
        ]);
        const document = await getServiceReportDocument(sql, draft.id);
        expect(document?.technician.fullName).toBe("David Fixture");
      }));
  },
);
