import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, it, expect, vi } from "vitest";
import {
  queueAttachmentOcr,
  linkReportAttachment,
  listServiceOcrQueuePage,
  confirmOcrCorrections,
  retailServiceWorkflowPolicy,
} from "@or-on/crm";
import { createMessagingStore } from "../src/database.js";
import { SimulatorWhatsAppProvider } from "../src/providers.js";
import type { FieldServiceAiProvider } from "../src/field-service-provider.js";
import type { JSONValue } from "postgres";

const source = process.env.CROSS_CHANNEL_TEST_DATABASE_URL;
describe.skipIf(!source)("owned OCR worker fixture", () => {
  it("processes queued labels under least privilege and fences foreign, withdrawn, disabled and stale work", async () => {
    if (source === undefined)
      throw new Error("Explicit fictional fixture database required");
    const target = new URL(source);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
      throw new Error("local synthetic DB only");
    target.pathname = "/postgres";
    const maintenance = postgres(target.toString(), { max: 1 });
    const name = "oron_extraction_priority_" + randomUUID().replaceAll("-", "");
    await maintenance.unsafe(`CREATE DATABASE "${name}"`);
    target.pathname = "/" + name;
    const db = postgres(target.toString(), { max: 1, prepare: false });
    const localRoot = await mkdtemp(
      join(process.cwd(), "extraction-priority-fixture-"),
    );
    try {
      execFileSync(
        "uv",
        [
          "run",
          "--no-sync",
          "alembic",
          "-c",
          "db/alembic/alembic.ini",
          "upgrade",
          "head",
        ],
        {
          cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
          env: { ...process.env, DATABASE_URL: target.toString() },
          stdio: "pipe",
        },
      );
      const tenant = randomUUID(),
        actor = randomUUID(),
        profile = randomUUID(),
        agent = randomUUID();
      await db`INSERT INTO public.tenants(id,name,slug) VALUES(${tenant}::uuid,'Fictional extraction',${tenant})`;
      await db`INSERT INTO public.users(id,email,status) VALUES(${actor}::uuid,${actor + "@example.invalid"},'active')`;
      await db`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${actor}::uuid,'owner')`;
      await db`SELECT set_config('app.current_tenant',${tenant},false),set_config('app.current_user',${actor},false),set_config('app.current_role','owner',false)`;
      await db`INSERT INTO crm.tenant_settings(tenant_id,locale,timezone) VALUES(${tenant}::uuid,'en','UTC')`;
      await db`INSERT INTO platform.tenant_feature_entitlements(tenant_id,feature_key,available,enabled,granted_at) VALUES(${tenant}::uuid,'whatsapp',true,true,clock_timestamp()) ON CONFLICT(tenant_id,feature_key) DO UPDATE SET available=true,enabled=true`;
      const workflowConfiguration = JSON.parse(
        JSON.stringify({ workflow: retailServiceWorkflowPolicy }),
      ) as JSONValue;
      await db`INSERT INTO platform.tenant_feature_entitlements(tenant_id,feature_key,available,enabled,granted_at,configuration) VALUES(${tenant}::uuid,'field_service',true,true,clock_timestamp(),${db.json(workflowConfiguration)})`;
      await db`INSERT INTO service.tenant_configuration(tenant_id,enabled,whatsapp_intake_enabled) VALUES(${tenant}::uuid,true,true)`;
      await db`INSERT INTO agents.agent_profiles(id,tenant_id,name) VALUES(${profile}::uuid,${tenant}::uuid,'Fictional service agent')`;
      await db`INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,system_prompt,locale,channel_capabilities,tool_permissions,validation_status,published_at) VALUES(${agent}::uuid,${tenant}::uuid,${profile}::uuid,1,'Help service customers','en',ARRAY['whatsapp'],'["service.intake"]','valid',clock_timestamp())`;
      const foreignTenant = randomUUID(),
        foreignActor = randomUUID();
      await db`INSERT INTO public.tenants(id,name,slug) VALUES(${foreignTenant}::uuid,'Other fictional tenant',${foreignTenant})`;
      await db`INSERT INTO public.users(id,email,status,display_name) VALUES(${foreignActor}::uuid,${foreignActor + "@example.invalid"},'active','Other fictional owner')`;
      await db`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${foreignTenant}::uuid,${foreignActor}::uuid,'owner')`;
      const inactiveActor = randomUUID();
      await db`UPDATE public.users SET display_name='Fictional extraction owner' WHERE id=${actor}::uuid`;
      await db`INSERT INTO public.users(id,email,status,display_name) VALUES(${inactiveActor}::uuid,${inactiveActor + "@example.invalid"},'disabled','Inactive fictional owner')`;
      await db`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${inactiveActor}::uuid,'owner')`;
      await db`UPDATE crm.tenant_settings SET whatsapp_ai_agent_profile_id=${profile}::uuid,whatsapp_ai_enabled_by_user_id=${actor}::uuid,whatsapp_ai_enabled_at=clock_timestamp() WHERE tenant_id=${tenant}::uuid`;
      target.searchParams.set("options", "-c role=platform_messaging");
      for (const feature of ["documents", "ocr"])
        await db`INSERT INTO platform.tenant_feature_entitlements(tenant_id,feature_key,available,enabled,granted_at) VALUES(${tenant}::uuid,${feature},true,true,clock_timestamp()) ON CONFLICT(tenant_id,feature_key) DO UPDATE SET available=true,enabled=true`;
      await db`UPDATE service.tenant_configuration SET ocr_enabled=true WHERE tenant_id=${tenant}::uuid`;
      const worker = postgres(target.toString(), { max: 1, prepare: false });
      const webTarget = new URL(target);
      webTarget.searchParams.set("options", "-c role=platform_web");
      const web = postgres(webTarget.toString(), { max: 1, prepare: false });
      try {
        for (const mode of [
          "success",
          "foreign",
          "disabled",
          "withdrawn",
          "stale",
          "actor_revoked",
          "config_revoked",
          "revoked",
          "source_changed",
          "checksum_changed",
          "role_revoked",
          "tech_assigned",
          "tech_appointment",
          "tech_unassigned",
          "tech_unlinked",
          "tech_revoked",
        ] as const) {
          await db`UPDATE service.tenant_configuration SET ocr_enabled=true WHERE tenant_id=${tenant}::uuid`;
          await db`UPDATE platform.tenant_feature_entitlements SET enabled=true WHERE tenant_id=${tenant}::uuid AND feature_key='ocr'`;
          await db`UPDATE public.users SET status='active' WHERE id=${actor}::uuid`;
          const contact = randomUUID(),
            caseId = randomUUID(),
            object = randomUUID();
          let uploader = actor;
          let appointment: string | undefined;
          if (mode.startsWith("tech_")) {
            uploader = randomUUID();
            await db`INSERT INTO public.users(id,email,status) VALUES(${uploader}::uuid,${uploader + "@example.invalid"},'active')`;
            await db`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${uploader}::uuid,'technician')`;
          }
          await db`UPDATE public.memberships SET role='owner' WHERE tenant_id=${tenant}::uuid AND user_id=${actor}::uuid`;
          const bytes = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=",
            "base64",
          );
          const checksum = createHash("sha256").update(bytes).digest("hex");
          await writeFile(join(localRoot, object + ".png"), bytes);
          await db`INSERT INTO crm.contacts(id,tenant_id,name) VALUES(${contact}::uuid,${tenant}::uuid,'Fictional OCR customer')`;
          await db`INSERT INTO service.cases(id,tenant_id,reference,customer_contact_id,title,fault_description,created_by_user_id) VALUES(${caseId}::uuid,${tenant}::uuid,${caseId},${contact}::uuid,'Fictional printer label','Fictional paper fault',${actor}::uuid)`;
          if (mode.startsWith("tech_") && mode !== "tech_unlinked") {
            const technician = randomUUID();
            await db`INSERT INTO service.technicians(id,tenant_id,full_name,linked_user_id,active) VALUES(${technician}::uuid,${tenant}::uuid,'Fictional linked technician',${uploader}::uuid,true)`;
            if (mode === "tech_assigned" || mode === "tech_revoked")
              await db`UPDATE service.cases SET assigned_technician_id=${technician}::uuid WHERE id=${caseId}::uuid`;
            if (mode === "tech_appointment") {
              appointment = randomUUID();
              await db`INSERT INTO service.appointments(id,tenant_id,case_id,technician_id,starts_at,ends_at,timezone,idempotency_key) VALUES(${appointment}::uuid,${tenant}::uuid,${caseId}::uuid,${technician}::uuid,NOW(),NOW()+interval '1 hour','UTC',${appointment})`;
            }
          }
          await db`INSERT INTO objects.object_metadata(id,tenant_id,owner_type,owner_id,category,content_type,byte_size,checksum,storage_backend,storage_key,status) VALUES(${object}::uuid,${tenant}::uuid,'service_case',${caseId}::uuid,'product_label','image/png',${bytes.length},${checksum},'local',${object + ".png"},'available')`;
          const { attachment, result } = await worker.begin(async (tx) => {
            await tx`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${actor},true),set_config('app.current_role','service',true)`;
            const attachment = await linkReportAttachment(tx, uploader, {
              caseId,
              objectId: object,
              category: "product_label",
              source: "operator",
            });
            return {
              attachment,
              result: await queueAttachmentOcr(tx, attachment, checksum),
            };
          });
          const jobs = await db<
            { id: string; queue: string; status: string }[]
          >`SELECT id,queue,status FROM ops.jobs WHERE reference_id=${result}::uuid`;
          const job = required(jobs[0]);
          if (appointment !== undefined) {
            const scopedAppointment = appointment;
            await worker.begin(async (tx) => {
              await tx`SELECT set_config('app.current_tenant',${tenant},true)`;
              const allowed = await tx<
                { allowed: boolean }[]
              >`SELECT service.ocr_origin_actor_authorized(${attachment}::uuid,${uploader}::uuid) AS allowed`;
              expect(required(allowed[0]).allowed).toBe(true);
              await expect(
                db.begin(async (other) => {
                  await other`SET LOCAL lock_timeout='100ms'`;
                  await other`UPDATE service.appointments SET status='cancelled' WHERE id=${scopedAppointment}::uuid`;
                }),
              ).rejects.toMatchObject({ code: "55P03" });
            });
          }
          expect(job.queue).toBe("field_service");
          expect(job.status).toBe("queued");
          if (mode === "foreign")
            await db`UPDATE ops.jobs SET tenant_id=${foreignTenant}::uuid WHERE id=${job.id}::uuid`;
          if (mode === "disabled")
            await db`UPDATE service.tenant_configuration SET ocr_enabled=false WHERE tenant_id=${tenant}::uuid`;
          const extract = vi
            .fn<FieldServiceAiProvider["extractProductLabel"]>()
            .mockImplementation(async (request) => {
              expect(request.bytes).toEqual(bytes);
              expect(request.contentType).toBe("image/png");
              if (mode === "withdrawn")
                await db`UPDATE service.ocr_results SET status='confirmed',confirmed_fields='{"serialNumber":"HUMAN-VERIFIED"}',manually_confirmed_fields=ARRAY['serialNumber'] WHERE id=${result}::uuid`;
              if (mode === "stale")
                await db`UPDATE ops.jobs SET locked_by='fresh-fictional-owner',claim_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '120 seconds' WHERE id=${job.id}::uuid`;
              if (mode === "revoked")
                await db`UPDATE platform.tenant_feature_entitlements SET enabled=false WHERE tenant_id=${tenant}::uuid AND feature_key='ocr'`;
              if (mode === "config_revoked")
                await db`UPDATE service.tenant_configuration SET ocr_enabled=false WHERE tenant_id=${tenant}::uuid`;
              if (mode === "actor_revoked")
                await db`UPDATE public.users SET status='disabled' WHERE id=${actor}::uuid`;
              if (mode === "source_changed")
                await db`UPDATE objects.object_metadata SET deleted_at=clock_timestamp() WHERE id=${object}::uuid`;
              if (mode === "checksum_changed")
                await db`UPDATE objects.object_metadata SET checksum=${"0".repeat(64)} WHERE id=${object}::uuid`;
              if (mode === "role_revoked")
                await db`UPDATE public.memberships SET role='viewer' WHERE tenant_id=${tenant}::uuid AND user_id=${actor}::uuid`;
              if (mode === "tech_revoked")
                await db`UPDATE service.cases SET assigned_technician_id=NULL WHERE id=${caseId}::uuid`;
              return {
                fields: {
                  productType: "Printer",
                  productModel: "FICTIONAL-M1",
                  serialNumber: "SYNTHETIC-123",
                },
                confidence: 0.91,
                fieldConfidence: { productModel: 0.93 },
              };
            });
          const store = createMessagingStore(
            target.toString(),
            randomUUID(),
            {
              simulator: new SimulatorWhatsAppProvider(),
              meta: { name: "meta", send: vi.fn() },
            },
            undefined,
            {
              privateObjectStorage: { localRoot },
              fieldServiceProvider: {
                extractProductLabel: extract,
                extractIntake: vi.fn(),
                summarizeEvidence: vi.fn(),
                providerName: "fictional",
                modelName: "fictional-ocr",
              },
            },
          );
          try {
            await store.processAvailable();
          } finally {
            await store.close();
          }
          const rows = await db<
            {
              status: string;
              proposed_fields: Record<string, string>;
              confirmed_fields: Record<string, string>;
              provenance: {
                humanReviewRequired?: boolean;
                sourceChecksum?: string;
              };
            }[]
          >`SELECT status,proposed_fields,confirmed_fields,provenance FROM service.ocr_results WHERE id=${result}::uuid`;
          const row = required(rows[0]);
          if (
            mode === "success" ||
            mode === "tech_assigned" ||
            mode === "tech_appointment"
          ) {
            expect(
              extract,
              mode +
                JSON.stringify(
                  await db`SELECT error_safe FROM service.ocr_results WHERE id=${result}::uuid`,
                ),
            ).toHaveBeenCalledOnce();
            expect(row.status).toBe("review_required");
            expect(row.proposed_fields.serialNumber).toBe("SYNTHETIC-123");
            expect(row.confirmed_fields).toEqual({});
            expect(row.provenance).toMatchObject({
              humanReviewRequired: true,
              sourceChecksum: checksum,
            });
            if (mode === "success")
              await web.begin(async (tx) => {
                await tx`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${actor},true),set_config('app.current_role','owner',true)`;
                const page = await listServiceOcrQueuePage(tx, {
                  view: "attention",
                });
                expect(page.items.some((item) => item.id === result)).toBe(
                  true,
                );
                await confirmOcrCorrections(
                  tx,
                  actor,
                  result,
                  { serialNumber: "HUMAN-VERIFIED" },
                  randomUUID(),
                );
              });
            const audit =
              await db`SELECT id FROM audit.records WHERE action='field_service.ocr.corrected' AND target_id=${result}::uuid`;
            expect(audit).toHaveLength(mode === "success" ? 1 : 0);
            const completed = await db<
              { status: string }[]
            >`SELECT status FROM ops.jobs WHERE id=${job.id}::uuid`;
            expect(required(completed[0]).status).toBe("succeeded");
            await worker.begin(async (tx) => {
              await tx`SELECT set_config('app.current_tenant',${foreignTenant},true)`;
              expect(
                await tx`SELECT id FROM service.ocr_results WHERE id=${result}::uuid`,
              ).toHaveLength(0);
            });
          } else if (mode === "withdrawn") {
            expect(row.status).toBe("confirmed");
            expect(row.confirmed_fields.serialNumber).toBe("HUMAN-VERIFIED");
            expect(row.proposed_fields).toEqual({});
          } else if (mode === "stale") {
            expect(row.status).toBe("processing");
            expect(row.proposed_fields).toEqual({});
            const fresh = await db<
              { status: string; locked_by: string }[]
            >`SELECT status,locked_by FROM ops.jobs WHERE id=${job.id}::uuid`;
            expect(required(fresh[0])).toMatchObject({
              status: "running",
              locked_by: "fresh-fictional-owner",
            });
            await db`UPDATE ops.jobs SET status='succeeded',locked_by=NULL,claim_token=NULL,lease_expires_at=NULL WHERE id=${job.id}::uuid`;
          } else if (
            mode === "revoked" ||
            mode === "config_revoked" ||
            mode === "actor_revoked" ||
            mode === "source_changed" ||
            mode === "checksum_changed" ||
            mode === "role_revoked" ||
            mode === "tech_revoked"
          ) {
            expect(extract).toHaveBeenCalledOnce();
            if (mode !== "revoked") expect(row.status).toBe("failed");
            expect(row.proposed_fields).toEqual({});
            const terminal = await db<
              { status: string }[]
            >`SELECT status FROM ops.jobs WHERE id=${job.id}::uuid`;
            expect(["dead", "cancelled"]).toContain(
              required(terminal[0]).status,
            );
          } else {
            expect(extract).not.toHaveBeenCalled();
            expect(row.proposed_fields).toEqual({});
          }
          expect(attachment).toBeTruthy();
        }
      } finally {
        await worker.end();
        await web.end();
      }
    } finally {
      await db.end();
      await maintenance.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await maintenance.end();
      await rm(localRoot, { recursive: true, force: true });
    }
  }, 120000);
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected OCR fixture value");
  return value;
}
