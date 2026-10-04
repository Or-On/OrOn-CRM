import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, it, expect, vi } from "vitest";
import { acceptWhatsAppWebhook, retailServiceWorkflowPolicy } from "@or-on/crm";
import { createMessagingStore } from "../src/database.js";
import {
  createChannelCredentialResolver,
  sealChannelCredential,
} from "../src/channel-credentials.js";
import type { WhatsAppProvider } from "../src/providers.js";
import {
  SimulatorWhatsAppProvider,
  WhatsAppProviderError,
} from "../src/providers.js";

const source = process.env.CROSS_CHANNEL_TEST_DATABASE_URL;
describe.skipIf(!source)("owned unsupported-media worker fixture", () => {
  it("rejects unsupported media honestly with duplicate and takeover fencing", async () => {
    const target = new URL(required(source));
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
      await db`INSERT INTO platform.tenant_feature_entitlements(tenant_id,feature_key,available,enabled,granted_at,configuration) VALUES(${tenant}::uuid,'field_service',true,true,clock_timestamp(),${JSON.stringify({ workflow: retailServiceWorkflowPolicy })}::text::jsonb)`;
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
      await db`INSERT INTO platform.tenant_remediation_flags(tenant_id,flag_key,enabled) VALUES(${tenant}::uuid,'no_silence',true)`;
      // Pause only this owned fixture's newly admitted jobs to exercise races
      // between durable ingress and a later fresh job claim without sleeps.
      await db`CREATE FUNCTION public.pause_fictional_media_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.job_type='whatsapp.unsupported.reply' THEN NEW.available_at=clock_timestamp()+interval '1 hour'; END IF; RETURN NEW; END $$`;
      await db`CREATE TRIGGER pause_fictional_media_job BEFORE INSERT ON ops.jobs FOR EACH ROW EXECUTE FUNCTION public.pause_fictional_media_job()`;
      for (const mode of [
        "video",
        "rate_limit",
        "credential_valid",
        "credential_revoked",
        "credential_media_valid",
        "credential_media_revoked",
        "credential_media_human",
        "sticker",
        "human",
        "send_takeover",
        "foreign",
        "sender_mismatch",
        "flag_off",
      ] as const) {
        const contact = randomUUID(),
          channel = randomUUID(),
          conversation = randomUUID(),
          identity = randomUUID();
        const address =
          "+1202555" +
          String(Math.floor(Math.random() * 10000)).padStart(4, "0");
        await db`INSERT INTO crm.contacts(id,tenant_id,name,whatsapp_consent) VALUES(${contact}::uuid,${tenant}::uuid,'Fictional media customer','granted')`;
        await db`INSERT INTO messaging.channels(id,tenant_id,kind,provider,provider_account_id,status,mirror_inbound_media,configuration) VALUES(${channel}::uuid,${tenant}::uuid,'whatsapp','meta',${channel},'active',true,${db.json({ phoneNumberId: channel, wabaId: "fictional", graphApiVersion: "v26.0" })})`;
        const credentialKey = Buffer.alloc(32, 23);
        if (mode.startsWith("credential_")) {
          const credential = randomUUID();
          const envelope = sealChannelCredential(
            { tenantId: tenant, channelId: channel, credentialId: credential },
            "fictional-stored-token",
            credentialKey,
          );
          await db`INSERT INTO platform.credential_records(id,tenant_id,kind,ciphertext,nonce,algorithm,key_version) VALUES(${credential}::uuid,${tenant}::uuid,${envelope.kind},${Buffer.from(envelope.ciphertext ?? "", "hex")},${Buffer.from(envelope.nonce ?? "", "hex")},${envelope.algorithm},${envelope.keyVersion})`;
          await db`UPDATE messaging.channels SET credential_id=${credential}::uuid WHERE id=${channel}::uuid`;
          if (
            mode === "credential_revoked" ||
            mode === "credential_media_revoked"
          )
            await db`UPDATE platform.credential_records SET ciphertext=NULL,nonce=NULL,algorithm=NULL,key_version=NULL WHERE id=${credential}::uuid`;
        }
        await db`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at) VALUES(${conversation}::uuid,${tenant}::uuid,${channel}::uuid,${contact}::uuid,'ai',${agent}::uuid,${actor}::uuid,clock_timestamp())`;
        if (mode === "credential_media_human")
          await db`UPDATE messaging.conversations SET ownership_mode='human',ai_enabled_by_user_id=NULL WHERE id=${conversation}::uuid`;
        await db`INSERT INTO crm.contact_channel_identities(id,tenant_id,contact_id,channel,normalized_value,provider,validation_status,is_primary) VALUES(${identity}::uuid,${tenant}::uuid,${contact}::uuid,'whatsapp',${address},'meta','valid',true)`;
        await db`UPDATE platform.tenant_remediation_flags SET enabled=${mode !== "flag_off"} WHERE tenant_id=${tenant}::uuid AND flag_key='no_silence'`;
        await db`INSERT INTO platform.tenant_remediation_flags(tenant_id,flag_key,enabled) VALUES(${tenant}::uuid,'typing',${mode.startsWith("credential_")}) ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=EXCLUDED.enabled`;
        const acknowledged = vi.fn();
        const sent = vi.fn<WhatsAppProvider["send"]>().mockResolvedValue({
            messageId: "wamid.synthetic-" + randomUUID(),
          }),
          download = vi.fn<NonNullable<WhatsAppProvider["downloadMedia"]>>(),
          decide = vi.fn().mockResolvedValue({
            action: "reply",
            text: "",
            replyCode: "clarify_rephrase",
          });
        const mediaHttp = vi.fn();
        download.mockImplementation(async (request) => {
          await request.beforeAttempt?.();
          const token = await request.accessTokenForAttempt?.();
          expect(token).toBe("fictional-stored-token");
          mediaHttp();
          await request.beforeAttempt?.();
          expect(await request.accessTokenForAttempt?.()).toBe(
            "fictional-stored-token",
          );
          mediaHttp();
          const bytes = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAF0lEQVR4nGP4TyFgGDVg1IBRA/4PEwMAXXj8LtKXk0wAAAAASUVORK5CYII=",
            "base64",
          );
          return {
            bytes,
            contentType: "image/png",
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        });
        if (mode === "rate_limit")
          sent.mockRejectedValue(
            new WhatsAppProviderError(
              "rate_limit_deferred",
              true,
              429,
              undefined,
              100000,
            ),
          );
        const workerTarget = new URL(target);
        workerTarget.searchParams.set("options", "-c role=platform_messaging");
        const store = createMessagingStore(
          workerTarget.toString(),
          randomUUID(),
          {
            simulator: new SimulatorWhatsAppProvider(),
            meta: {
              name: "meta",
              acknowledgeInbound: async (request) => {
                await request.beforeAttempt();
                const token = await request.accessTokenForAttempt?.();
                if (mode.startsWith("credential_"))
                  expect(token).toBe("fictional-stored-token");
                acknowledged();
              },
              downloadMedia: download,
              send: async (request) => {
                if (mode === "send_takeover")
                  await db`UPDATE messaging.conversations SET ownership_mode='human',ownership_epoch=ownership_epoch+1 WHERE id=${conversation}::uuid`;
                await request.beforeAttempt?.();
                const token = await request.accessTokenForAttempt?.();
                if (mode === "credential_valid") {
                  expect(token).toBe("fictional-stored-token");
                  const refs = await db<
                    { credential_id: string }[]
                  >`SELECT credential_id FROM messaging.channels WHERE id=${channel}::uuid`;
                  const ref = required(refs[0]).credential_id;
                  const rotated = sealChannelCredential(
                    { tenantId: tenant, channelId: channel, credentialId: ref },
                    "fictional-rotated-token",
                    credentialKey,
                  );
                  await db`UPDATE platform.credential_records SET ciphertext=${Buffer.from(rotated.ciphertext ?? "", "hex")},nonce=${Buffer.from(rotated.nonce ?? "", "hex")},rotated_at=clock_timestamp() WHERE id=${ref}::uuid`;
                  expect(await request.accessTokenForAttempt?.()).toBe(
                    "fictional-rotated-token",
                  );
                  const claims = await db<
                    { id: string; locked_by: string; claim_token: string }[]
                  >`SELECT j.id,j.locked_by,j.claim_token FROM ops.jobs j JOIN messaging.outbound_requests r ON r.id=j.reference_id WHERE r.conversation_id=${conversation}::uuid AND j.status='running'`;
                  const claim = required(claims[0]);
                  for (const testedTenant of [tenant, randomUUID()])
                    await db.begin(async (tx) => {
                      await tx`SET LOCAL ROLE platform_messaging`;
                      await tx`SELECT set_config('app.current_tenant',${testedTenant},true)`;
                      const denied = await tx<
                        { envelope: unknown }[]
                      >`SELECT platform.messaging_outbound_channel_credential(${claim.id}::uuid,${claim.locked_by},${testedTenant === tenant ? randomUUID() : claim.claim_token}::uuid) AS envelope`;
                      expect(required(denied[0]).envelope).toBeNull();
                    });
                }
                return sent(request);
              },
            },
          },
          undefined,
          {
            realWhatsAppEnabled: true,
            privateObjectStorage: { localRoot },
            aiProvider: { decide },
            resolveChannelCredential: createChannelCredentialResolver(
              new Map([["env:wa:v2", credentialKey]]),
            ),
          },
        );
        const providerId = "wamid.media-" + randomUUID(),
          secret = "fictional-media-secret";
        const accept = async (id: string, type: string) => {
          const payload =
            type === "text"
              ? { text: { body: "Fictional follow-up text" } }
              : {
                  [type]: {
                    id: "fictional-private-media",
                    mime_type:
                      type === "sticker"
                        ? "image/webp"
                        : type === "image"
                          ? "image/png"
                          : "video/3gpp",
                  },
                };
          const raw = Buffer.from(
            JSON.stringify({
              entry: [
                {
                  id: "fictional",
                  changes: [
                    {
                      value: {
                        metadata: { phone_number_id: channel },
                        messages: [
                          {
                            id,
                            from: address.slice(1),
                            timestamp: String(Math.floor(Date.now() / 1000)),
                            type,
                            ...payload,
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
            "sha256=" + createHmac("sha256", secret).update(raw).digest("hex"),
            secret,
          );
        };
        try {
          const inboundType = mode.startsWith("credential_media_")
            ? "image"
            : mode === "sticker"
              ? "sticker"
              : "video";
          await accept(providerId, inboundType);
          await accept(providerId, inboundType);
          await store.processAvailable();
          if (mode.startsWith("credential_media_")) {
            for (let pass = 0; pass < 8; pass++) await store.processAvailable();
            const mirrored = await db<
              {
                object_id: string | null;
                structured_content: { retrievalStatus?: string };
              }[]
            >`SELECT object_id,structured_content FROM messaging.messages WHERE conversation_id=${conversation}::uuid AND direction='inbound'`;
            const row = required(mirrored[0]);
            if (mode === "credential_media_revoked") {
              expect(mediaHttp).not.toHaveBeenCalled();
              expect(row.object_id).toBeNull();
              expect(row.structured_content.retrievalStatus).toBe("failed");
            } else {
              expect(mediaHttp).toHaveBeenCalledTimes(2);
              expect(
                row.object_id,
                mode + JSON.stringify(row.structured_content),
              ).not.toBeNull();
              expect(row.structured_content.retrievalStatus).toBe("available");
            }
            continue;
          }
          if (mode === "credential_valid")
            expect(acknowledged).toHaveBeenCalledOnce();
          if (mode === "credential_revoked")
            expect(acknowledged).not.toHaveBeenCalled();
          const inbound = await db<
            { id: string; structured_content: { retrievalStatus?: string } }[]
          >`SELECT id,structured_content FROM messaging.messages WHERE conversation_id=${conversation}::uuid AND direction='inbound'`;
          expect(inbound).toHaveLength(1);
          if (mode !== "flag_off")
            expect(inbound[0]?.structured_content.retrievalStatus).toBe(
              "unsupported",
            );
          if (mode === "human")
            await db`UPDATE messaging.conversations SET ownership_mode='human',ownership_epoch=ownership_epoch+1 WHERE id=${conversation}::uuid`;
          if (mode === "foreign")
            await db`UPDATE ops.jobs SET tenant_id=${foreignTenant}::uuid WHERE reference_id=${conversation}::uuid AND job_type='whatsapp.unsupported.reply'`;
          if (mode === "sender_mismatch")
            await db`UPDATE messaging.inbound_message_origins SET sender_address='+12025559999' WHERE message_id=${required(inbound[0]).id}::uuid`;
          await db`UPDATE ops.jobs SET available_at=clock_timestamp() WHERE reference_id=${conversation}::uuid AND job_type='whatsapp.unsupported.reply'`;
          for (let i = 0; i < 8; i++)
            if ((await store.processAvailable()) === 0) break;
          expect(decide).not.toHaveBeenCalled();
          if (mode !== "flag_off") expect(download).not.toHaveBeenCalled();
          const diagnostic =
            await db`SELECT job_type,status,last_error_safe FROM ops.jobs WHERE reference_id=${conversation}::uuid`;
          expect(sent, mode + JSON.stringify(diagnostic)).toHaveBeenCalledTimes(
            mode === "video" ||
              mode === "sticker" ||
              mode === "rate_limit" ||
              mode === "credential_valid"
              ? 1
              : 0,
          );
          if (mode === "credential_revoked") {
            const failed = await db<
              { last_error_code: string; status: string }[]
            >`SELECT last_error_code,status FROM messaging.outbound_requests WHERE conversation_id=${conversation}::uuid`;
            expect(required(failed[0])).toMatchObject({
              status: "failed",
              last_error_code: "channel_credential_unavailable",
            });
          }
          if (mode === "rate_limit") {
            const queued = await db<
              { status: string; delay: number }[]
            >`SELECT status,EXTRACT(EPOCH FROM(available_at-clock_timestamp()))::float AS delay FROM ops.jobs WHERE tenant_id=${tenant}::uuid AND job_type='whatsapp.outbound.send' AND status='retry'`;
            expect(queued).toHaveLength(1);
            expect(required(queued[0]).delay).toBeGreaterThan(98);
            await store.processAvailable();
            expect(sent).toHaveBeenCalledOnce();
          }
          if (mode === "video" || mode === "sticker") {
            const delivery = required(sent.mock.calls[0])[0].delivery;
            if (delivery.kind !== "text")
              throw new Error("Expected text fallback");
            expect(delivery.text).toContain("cannot read this media type");
            const jobs =
              await db`SELECT id FROM ops.jobs WHERE reference_id=${conversation}::uuid AND job_type='whatsapp.unsupported.reply'`;
            expect(jobs).toHaveLength(1);
            await accept("wamid.text-" + randomUUID(), "text");
            for (let i = 0; i < 8; i++)
              if ((await store.processAvailable()) === 0) break;
            const textJobs =
              await db`SELECT job_type,status,last_error_safe FROM ops.jobs WHERE reference_id=${conversation}::uuid`;
            expect(decide, JSON.stringify(textJobs)).toHaveBeenCalledTimes(1);
            expect(sent).toHaveBeenCalledTimes(2);
          }
        } finally {
          await store.close();
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

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected fixture value");
  return value;
}
