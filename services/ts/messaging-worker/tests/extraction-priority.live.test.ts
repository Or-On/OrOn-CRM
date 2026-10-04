import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, it, expect, vi } from "vitest";
import {
  acceptWhatsAppWebhook,
  retailServiceWorkflowPolicy,
  getFieldServiceFeatureState,
  getServiceWorkflowPolicy,
  findOpenWhatsAppServiceIntake,
} from "@or-on/crm";
import { createMessagingStore } from "../src/database.js";
import { SimulatorWhatsAppProvider } from "../src/providers.js";
import type { AudioTranscriber } from "../src/audio-transcription.js";
import type { JSONValue } from "postgres";

const source = process.env.CROSS_CHANNEL_TEST_DATABASE_URL;
describe.skipIf(!source)("owned extraction priority fixture", () => {
  it("preserves off20 and enables10 for text and committed transcripts", async () => {
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
      for (const enabled of [false, true]) {
        await db`INSERT INTO platform.tenant_remediation_flags(tenant_id,flag_key,enabled) VALUES(${tenant}::uuid,'queue_priority',${enabled}) ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=EXCLUDED.enabled`;
        for (const kind of ["text", "audio"]) {
          const contact = randomUUID(),
            channel = randomUUID(),
            conversation = randomUUID(),
            message = randomUUID(),
            operation = randomUUID();
          const address =
            "+1202555" +
            String(Math.floor(Math.random() * 10000)).padStart(4, "0");
          await db`INSERT INTO crm.contacts(id,tenant_id,name,whatsapp_consent) VALUES(${contact}::uuid,${tenant}::uuid,'Fictional extraction customer','granted')`;
          await db`INSERT INTO messaging.channels(id,tenant_id,kind,provider,provider_account_id,status,configuration) VALUES(${channel}::uuid,${tenant}::uuid,'whatsapp','meta',${channel},'active',${db.json({ phoneNumberId: channel, wabaId: "fictional", graphApiVersion: "v26.0" })})`;
          await db`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at) VALUES(${conversation}::uuid,${tenant}::uuid,${channel}::uuid,${contact}::uuid,'ai',${agent}::uuid,${actor}::uuid,clock_timestamp())`;
          const identity = randomUUID();
          await db`INSERT INTO crm.contact_channel_identities(id,tenant_id,contact_id,channel,normalized_value,provider,validation_status,is_primary) VALUES(${identity}::uuid,${tenant}::uuid,${contact}::uuid,'whatsapp',${address},'meta','valid',true)`;
          const extract = vi.fn().mockResolvedValue({
            serviceIntent: false,
            confirmed: false,
            confidence: 1,
            fields: {},
          });
          const start: AudioTranscriber["start"] = async (input) => {
            await input.beforeAttempt();
            const fileId = randomUUID();
            await input.checkpoint({
              phase: "upload_inflight",
              operationId: input.operationId,
            });
            await input.checkpoint({
              phase: "uploaded",
              operationId: input.operationId,
              fileId,
            });
            await input.checkpoint({
              phase: "submit_inflight",
              operationId: input.operationId,
              fileId,
            });
            const ticket = {
              operationId: input.operationId,
              fileId,
              providerJobId: randomUUID(),
            };
            await input.checkpoint({ phase: "submitted", ticket });
            return {
              kind: "completed",
              ticket,
              text: "Fictional customer printer request",
            };
          };
          const store = createMessagingStore(
            target.toString(),
            randomUUID(),
            {
              simulator: new SimulatorWhatsAppProvider(),
              meta: { name: "meta", send: vi.fn() },
            },
            undefined,
            {
              realWhatsAppEnabled: true,
              fieldServiceProvider: {
                extractIntake: extract,
                extractProductLabel: vi.fn(),
                summarizeEvidence: vi.fn(),
                providerName: "fictional",
                modelName: "fictional",
              },
              privateObjectStorage: { localRoot },
              audioTranscriber: { start, poll: vi.fn() },
            },
          );
          try {
            const probe = postgres(target.toString(), { max: 1 });
            try {
              await expect(
                probe.begin(async (tx) => {
                  await tx`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_role','service',true)`;
                  await tx`SELECT locale FROM crm.tenant_settings WHERE tenant_id=${tenant}::uuid`;
                }),
              ).rejects.toMatchObject({ code: "42501" });
            } finally {
              await probe.end();
            }
            const narrowProbe = postgres(target.toString(), { max: 1 });
            try {
              await narrowProbe.begin(async (tx) => {
                await tx`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_role','service',true)`;
                const profiles = await tx<
                  { profile: { tenantName: string }; ready: boolean }[]
                >`SELECT platform.current_voice_tenant_support_profile() AS profile, platform.current_field_service_whatsapp_agent_ready() AS ready`;
                expect(profiles[0]?.profile.tenantName).toBe(
                  "Fictional extraction",
                );
                expect(profiles[0]?.ready).toBe(true);
                await tx`SELECT service.contact_intake_context(${contact}::uuid)`;
                const foreign =
                  await tx`SELECT platform.current_tenant_member_display_name(${foreignActor}::uuid) AS name`;
                expect(foreign[0]?.name).toBeNull();
                const members =
                  await tx`SELECT platform.current_tenant_member_display_name(${actor}::uuid) AS owner,platform.current_tenant_member_display_name(${inactiveActor}::uuid) AS inactive`;
                expect(members[0]?.owner).toBe("Fictional extraction owner");
                expect(members[0]?.inactive).toBeNull();
                await tx`SELECT set_config('app.current_tenant',${foreignTenant},true)`;
                const foreignReadiness =
                  await tx`SELECT platform.current_field_service_whatsapp_agent_ready() AS ready`;
                expect(foreignReadiness[0]?.ready).toBe(false);
                await tx`SELECT set_config('app.current_tenant',${tenant},true)`;
                await getFieldServiceFeatureState(tx);
                await getServiceWorkflowPolicy(tx);
                await findOpenWhatsAppServiceIntake(tx, conversation);
              });
            } finally {
              await narrowProbe.end();
            }
            if (kind === "text") {
              const secret = "fictional-extraction-app-secret";
              const raw = Buffer.from(
                JSON.stringify({
                  entry: [
                    {
                      id: "fixture",
                      changes: [
                        {
                          value: {
                            metadata: { phone_number_id: channel },
                            messages: [
                              {
                                id: message,
                                from: address.slice(1),
                                type: "text",
                                text: { body: "Fictional printer question" },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  ],
                }),
              );
              await acceptWhatsAppWebhook(
                target.toString(),
                raw,
                "sha256=" +
                  createHmac("sha256", secret).update(raw).digest("hex"),
                secret,
              );
            } else {
              for (const flag of ["audio_transcription", "no_silence"])
                await db`INSERT INTO platform.tenant_remediation_flags(tenant_id,flag_key,enabled) VALUES(${tenant}::uuid,${flag},true) ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=true`;
              const object = randomUUID(),
                bytes = Buffer.from("fictional private audio"),
                sha = createHash("sha256").update(bytes).digest("hex");
              await writeFile(join(localRoot, object + ".wav"), bytes);
              await db`INSERT INTO objects.object_metadata(id,tenant_id,owner_type,owner_id,category,content_type,byte_size,checksum,storage_backend,storage_key,status) VALUES(${object}::uuid,${tenant}::uuid,'message',${message}::uuid,'whatsapp_customer_audio','audio/wav',${bytes.length},${sha},'local',${object + ".wav"},'available')`;
              await db`INSERT INTO messaging.messages(id,tenant_id,conversation_id,direction,sender_type,content_type,provider,provider_message_id,status,object_id,structured_content) VALUES(${message}::uuid,${tenant}::uuid,${conversation}::uuid,'inbound','contact','audio','meta',${message},'received',${object}::uuid,'{"transcriptionStatus":"pending"}')`;
              await db`INSERT INTO messaging.inbound_message_origins(tenant_id,message_id,contact_identity_id,sender_address) VALUES(${tenant}::uuid,${message}::uuid,${identity}::uuid,${address})`;
              await db`INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,max_attempts,priority) VALUES(${tenant}::uuid,'messaging','whatsapp.audio.transcribe','conversation',${conversation}::uuid,${db.json({ operationId: operation, messageId: message, objectId: object, sha256: sha, conversationId: conversation, triggerMessageId: message })},${"audio:" + operation},20,100)`;
            }
            for (let pass = 0; pass < 8; pass++)
              if ((await store.processAvailable()) === 0) break;
            const jobs = await db<
              { priority: number; tenant_id: string }[]
            >`SELECT priority,tenant_id FROM ops.jobs WHERE job_type='field_service.intake.extract' AND payload->>'conversationId'=${conversation}`;
            if (jobs.length !== 1)
              throw new Error(
                JSON.stringify(
                  await db`SELECT job_type,status,last_error_safe FROM ops.jobs WHERE tenant_id=${tenant}::uuid`,
                ),
              );
            expect(jobs).toEqual([
              { priority: enabled ? 10 : 20, tenant_id: tenant },
            ]);
            if (extract.mock.calls.length !== 1)
              throw new Error(
                JSON.stringify(
                  await db`SELECT status,last_error_safe FROM ops.jobs WHERE job_type='field_service.intake.extract' AND payload->>'conversationId'=${conversation}`,
                ),
              );
          } finally {
            await store.close();
          }
        }
      }
    } finally {
      await db.end();
      await maintenance.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await maintenance.end();
      await rm(localRoot, { recursive: true, force: true });
    }
  }, 120000);
});
