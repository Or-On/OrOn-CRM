import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
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
describe.skipIf(!source)("owned private inbound media files", () => {
  it("persists bounded files and fences post-download authority and interpretation", async () => {
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
      await db`INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,system_prompt,locale,channel_capabilities,tool_permissions,validation_status,published_at) VALUES(${agent}::uuid,${tenant}::uuid,${profile}::uuid,1,'Help service customers','en',ARRAY['whatsapp'],'[]','valid',clock_timestamp())`;
      await db`INSERT INTO platform.tenant_remediation_flags(tenant_id,flag_key,enabled) VALUES(${tenant}::uuid,'no_silence',true),(${tenant}::uuid,'audio_transcription',false)`;
      const privilege = await db<
        { allowed: boolean }[]
      >`SELECT has_function_privilege('platform_web','platform.authorize_media_commit(uuid,text,uuid,bigint,text)','EXECUTE') AS allowed`;
      expect(required(privilege[0]).allowed).toBe(false);
      const foreignScope = randomUUID();
      await db`INSERT INTO public.tenants(id,name,slug) VALUES(${foreignScope}::uuid,'Fictional foreign media scope',${foreignScope})`;
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAF0lEQVR4nGP4TyFgGDVg1IBRA/4PEwMAXXj8LtKXk0wAAAAASUVORK5CYII=",
        "base64",
      );
      const video = await readFile(
        fileURLToPath(
          new URL(
            "../../../../packages/ts/crm/src/fixtures/customer-video-aac.mp4",
            import.meta.url,
          ),
        ),
      );
      const wav = Buffer.alloc(2044);
      wav.write("RIFF");
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(16000, 24);
      wav.writeUInt32LE(32000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(2000, 40);
      for (const kind of ["image", "audio", "video"] as const)
        for (const mode of [
          "valid",
          "epoch",
          "account",
          "entitlement",
          "identity",
          "crossclass",
          "retry",
          "flagsOff",
          "staleClaim",
          "inactive",
          "sourceChanged",
          "featureLockRace",
          "postGuardRace",
          "credentialRevoked",
        ] as const) {
          const contact = randomUUID(),
            channel = randomUUID(),
            conversation = randomUUID(),
            identity = randomUUID();
          const address =
            "+1555" +
            String(Math.floor(Math.random() * 10000000)).padStart(7, "0");
          await db`UPDATE platform.tenant_remediation_flags SET enabled=${mode !== "flagsOff"} WHERE tenant_id=${tenant}::uuid AND flag_key='no_silence'`;
          await db`UPDATE platform.tenant_feature_entitlements SET enabled=true,available=true WHERE tenant_id=${tenant}::uuid AND feature_key='whatsapp'`;
          await db`INSERT INTO crm.contacts(id,tenant_id,name,whatsapp_consent) VALUES(${contact}::uuid,${tenant}::uuid,'Fictional private files','granted')`;
          await db`INSERT INTO messaging.channels(id,tenant_id,kind,provider,provider_account_id,status,mirror_inbound_media,configuration) VALUES(${channel}::uuid,${tenant}::uuid,'whatsapp','meta',${channel},'active',true,${db.json({ phoneNumberId: channel, wabaId: "fictional", graphApiVersion: "v26.0" })})`;
          await db`INSERT INTO crm.contact_channel_identities(id,tenant_id,contact_id,channel,normalized_value,provider,validation_status,is_primary) VALUES(${identity}::uuid,${tenant}::uuid,${contact}::uuid,'whatsapp',${address},'meta','valid',true)`;
          await db`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at) VALUES(${conversation}::uuid,${tenant}::uuid,${channel}::uuid,${contact}::uuid,'ai',${agent}::uuid,${actor}::uuid,clock_timestamp())`;
          const credentialKey = Buffer.alloc(32, 44);
          let credentialId: string | undefined;
          if (mode === "credentialRevoked") {
            credentialId = randomUUID();
            const sealed = sealChannelCredential(
              { tenantId: tenant, channelId: channel, credentialId },
              "fictional-media-token",
              credentialKey,
            );
            await db`INSERT INTO platform.credential_records(id,tenant_id,kind,ciphertext,nonce,algorithm,key_version) VALUES(${credentialId}::uuid,${tenant}::uuid,${sealed.kind},${Buffer.from(sealed.ciphertext ?? "", "hex")},${Buffer.from(sealed.nonce ?? "", "hex")},${sealed.algorithm},${sealed.keyVersion})`;
            await db`UPDATE messaging.channels SET credential_id=${credentialId}::uuid WHERE id=${channel}::uuid`;
          }
          const bytes =
            mode === "crossclass"
              ? kind === "video"
                ? png
                : video
              : kind === "image"
                ? png
                : kind === "audio"
                  ? wav
                  : video;
          const mime =
            mode === "crossclass"
              ? kind === "video"
                ? "image/png"
                : "video/mp4"
              : kind === "image"
                ? "image/png"
                : kind === "audio"
                  ? "audio/wav"
                  : "video/mp4";
          let downloads = 0;
          let lockProof: Promise<void> | undefined;
          let lockFailure: unknown;
          let raceObserved = false;
          const sent = vi
            .fn<WhatsAppProvider["send"]>()
            .mockResolvedValue({ messageId: "fictional-" + randomUUID() });
          const decide = vi.fn().mockResolvedValue({
            action: "reply",
            text: "",
            replyCode: "clarify_rephrase",
          });
          const workerTarget = new URL(target);
          workerTarget.searchParams.set(
            "options",
            "-c role=platform_messaging",
          );
          const store = createMessagingStore(
            workerTarget.toString(),
            randomUUID(),
            {
              simulator: new SimulatorWhatsAppProvider(),
              meta: {
                name: "meta",
                send: async (request) => {
                  await request.beforeAttempt?.();
                  await request.accessTokenForAttempt?.();
                  return sent(request);
                },
                downloadMedia: async (request) => {
                  await request.beforeAttempt?.();
                  const resolved = await request.accessTokenForAttempt?.();
                  expect(resolved).toBe(
                    mode === "credentialRevoked"
                      ? "fictional-media-token"
                      : undefined,
                  );
                  const claims = await db<
                    {
                      id: string;
                      locked_by: string;
                      claim_token: string;
                      epoch: string;
                    }[]
                  >`SELECT j.id,j.locked_by,j.claim_token,c.ownership_epoch::text AS epoch FROM ops.jobs j JOIN messaging.messages m ON m.id=j.reference_id AND m.tenant_id=j.tenant_id JOIN messaging.conversations c ON c.id=m.conversation_id AND c.tenant_id=m.tenant_id WHERE m.conversation_id=${conversation}::uuid AND j.job_type='whatsapp.media.retrieve' AND j.status='running'`;
                  const owned = required(claims[0]);
                  for (const scope of [tenant, foreignScope])
                    await db.begin(async (tx) => {
                      await tx`SET LOCAL ROLE platform_messaging`;
                      await tx`SELECT set_config('app.current_tenant',${scope},true)`;
                      const verdict = await tx<
                        { allowed: boolean }[]
                      >`SELECT platform.authorize_media_commit(${owned.id}::uuid,${owned.locked_by},${scope === tenant ? randomUUID() : owned.claim_token}::uuid,${owned.epoch}::bigint,${channel}) AS allowed`;
                      expect(required(verdict[0]).allowed).toBe(false);
                    });
                  downloads++;
                  if (mode === "retry" && downloads === 1)
                    throw new WhatsAppProviderError(
                      "media_transport_error",
                      true,
                    );
                  if (mode === "credentialRevoked")
                    await db`UPDATE platform.credential_records SET ciphertext=NULL,nonce=NULL,algorithm=NULL,key_version=NULL WHERE id=${credentialId ?? null}::uuid`;
                  if (mode === "epoch")
                    await db`UPDATE messaging.conversations SET ownership_mode='human',ai_agent_profile_version_id=NULL,ai_enabled_by_user_id=NULL WHERE id=${conversation}::uuid`;
                  if (mode === "account")
                    await db`UPDATE messaging.channels SET provider_account_id=${randomUUID()} WHERE id=${channel}::uuid`;
                  if (mode === "entitlement")
                    await db`UPDATE platform.tenant_feature_entitlements SET enabled=false WHERE tenant_id=${tenant}::uuid AND feature_key='whatsapp'`;
                  if (mode === "identity")
                    await db`UPDATE crm.contact_channel_identities SET validation_status='invalid' WHERE id=${identity}::uuid`;
                  if (mode === "inactive")
                    await db`UPDATE messaging.channels SET status='inactive' WHERE id=${channel}::uuid`;
                  if (mode === "sourceChanged")
                    await db`UPDATE messaging.messages SET structured_content=jsonb_set(structured_content,'{providerMediaId}','"different-fictional-media"'::jsonb) WHERE conversation_id=${conversation}::uuid AND direction='inbound'`;
                  if (mode === "staleClaim")
                    await db`UPDATE ops.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=${tenant}::uuid AND job_type='whatsapp.media.retrieve' AND status='running' AND reference_id IN (SELECT id FROM messaging.messages WHERE conversation_id=${conversation}::uuid)`;

                  if (mode === "featureLockRace" || mode === "postGuardRace") {
                    const blocker = postgres(target.toString(), {
                      max: 1,
                      prepare: false,
                    });
                    if (mode === "featureLockRace") {
                      await blocker.unsafe("BEGIN");
                      await blocker`UPDATE platform.tenant_feature_entitlements SET enabled=false WHERE tenant_id=${tenant}::uuid AND feature_key='whatsapp'`;
                      lockProof = (async () => {
                        try {
                          raceObserved = await actualLock(
                            db,
                            "%authorize_media_commit%",
                          );
                          await blocker.unsafe("COMMIT");
                        } finally {
                          await blocker
                            .unsafe("ROLLBACK")
                            .catch(() => undefined);
                          await blocker.end();
                        }
                      })().catch((error: unknown) => {
                        lockFailure = error;
                      });
                    } else {
                      const revoker = postgres(target.toString(), {
                        max: 1,
                        prepare: false,
                      });
                      const rows = await db<
                        { id: string }[]
                      >`SELECT id FROM messaging.messages WHERE conversation_id=${conversation}::uuid AND direction='inbound'`;
                      const message = required(rows[0]).id;
                      await blocker`SELECT pg_advisory_lock(734192)`;
                      await db.unsafe(
                        `CREATE FUNCTION public.pause_owned_media_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_id='${message}'::uuid THEN PERFORM pg_advisory_xact_lock(734192); END IF; RETURN NEW; END $$`,
                      );
                      await db.unsafe(
                        "CREATE TRIGGER pause_owned_media_commit BEFORE INSERT ON objects.object_metadata FOR EACH ROW EXECUTE FUNCTION public.pause_owned_media_commit()",
                      );
                      lockProof = (async () => {
                        let revoke: Promise<unknown> | undefined;
                        try {
                          if (
                            !(await actualLock(
                              db,
                              "%objects.object_metadata%",
                              true,
                            ))
                          )
                            throw new Error(
                              "Owned postguard insert pause not observed",
                            );
                          revoke =
                            revoker`UPDATE platform.tenant_feature_entitlements SET enabled=false WHERE tenant_id=${tenant}::uuid AND feature_key='whatsapp'`.then(
                              () => undefined,
                            );
                          raceObserved = await actualLock(
                            db,
                            "UPDATE platform.tenant_feature_entitlements%",
                          );
                        } finally {
                          await blocker`SELECT pg_advisory_unlock(734192)`;
                          await revoke;
                          await blocker.end();
                          await revoker.end();
                        }
                      })().catch((error: unknown) => {
                        lockFailure = error;
                      });
                    }
                  }
                  return {
                    bytes,
                    contentType: mime,
                    sha256: createHash("sha256").update(bytes).digest("hex"),
                  };
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
          const providerId = "wamid.private-" + randomUUID(),
            secret = "fictional-private-media";
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
                            id: providerId,
                            from: address.slice(1),
                            timestamp: String(Math.floor(Date.now() / 1000)),
                            type: kind,
                            [kind]: {
                              id: "fictional-media",
                              ...(mode === "crossclass"
                                ? {}
                                : { mime_type: mime }),
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            }),
          );
          const accept = () =>
            acceptWhatsAppWebhook(
              target.toString(),
              raw,
              "sha256=" +
                createHmac("sha256", secret).update(raw).digest("hex"),
              secret,
            );
          try {
            await accept();
            await accept();
            for (let pass = 0; pass < 10; pass++) {
              await store.processAvailable();
              await store.drainReplies();
              if (mode === "retry")
                await db`UPDATE ops.jobs SET available_at=clock_timestamp() WHERE tenant_id=${tenant}::uuid AND job_type='whatsapp.media.retrieve' AND status='retry'`;
              if (mode === "staleClaim" && downloads > 0) break;
            }
            await lockProof;
            if (lockFailure !== undefined)
              throw lockFailure instanceof Error
                ? lockFailure
                : new Error("Owned lock proof failed");
            if (mode === "featureLockRace" || mode === "postGuardRace")
              expect(raceObserved, kind + ":" + mode + ":actualPGwait").toBe(
                true,
              );
            if (mode === "postGuardRace") {
              await db.unsafe(
                "DROP TRIGGER pause_owned_media_commit ON objects.object_metadata",
              );
              await db.unsafe(
                "DROP FUNCTION public.pause_owned_media_commit()",
              );
            }
            const rows = await db<
              {
                id: string;
                object_id: string | null;
                structured_content: Record<string, unknown>;
              }[]
            >`SELECT id,object_id,structured_content FROM messaging.messages WHERE tenant_id=${tenant}::uuid AND conversation_id=${conversation}::uuid AND direction='inbound'`;
            expect(rows).toHaveLength(1);
            const row = required(rows[0]);
            const allowed =
              mode === "valid" ||
              mode === "retry" ||
              mode === "flagsOff" ||
              mode === "postGuardRace";
            const debugJobs = await db<
              {
                job_type: string;
                status: string;
                last_error_safe: string | null;
              }[]
            >`SELECT job_type,status,last_error_safe FROM ops.jobs WHERE tenant_id=${tenant}::uuid AND (reference_id=${conversation}::uuid OR reference_id=${row.id}::uuid)`;
            expect(
              row.object_id !== null,
              kind +
                ":" +
                mode +
                ":" +
                JSON.stringify({
                  content: row.structured_content,
                  jobs: debugJobs,
                }),
            ).toBe(allowed);
            const objects = await db<
              { storage_key: string; checksum: string; byte_size: string }[]
            >`SELECT storage_key,checksum,byte_size FROM objects.object_metadata WHERE tenant_id=${tenant}::uuid AND owner_type='message' AND owner_id=${row.id}::uuid`;
            expect(objects.length, kind + ":" + mode).toBe(allowed ? 1 : 0);
            if (allowed) {
              const object = required(objects[0]);
              const stored = await readFile(
                join(localRoot, ...object.storage_key.split("/")),
              );
              expect(stored).toEqual(bytes);
              expect(createHash("sha256").update(stored).digest("hex")).toBe(
                object.checksum,
              );
            }
            expect(downloads, kind + ":" + mode).toBe(mode === "retry" ? 2 : 1);
            if (mode === "staleClaim")
              await db`UPDATE ops.jobs SET status='dead',locked_by=NULL,locked_at=NULL,lease_expires_at=NULL WHERE tenant_id=${tenant}::uuid AND job_type='whatsapp.media.retrieve' AND reference_id=${row.id}::uuid`;
            const stt = await db<
              { count: string }[]
            >`SELECT count(*)::text AS count FROM ops.jobs WHERE tenant_id=${tenant}::uuid AND reference_id=${conversation}::uuid AND job_type='whatsapp.audio.transcribe'`;
            expect(required(stt[0]).count).toBe("0");
            if (kind === "audio" && allowed)
              expect(row.structured_content.transcriptionStatus).toBe(
                "disabled",
              );
            if (kind === "video" && allowed && mode !== "postGuardRace") {
              expect(decide).not.toHaveBeenCalled();
              expect(sent).toHaveBeenCalledTimes(mode === "flagsOff" ? 0 : 1);
              if (mode !== "flagsOff") {
                const delivery = required(sent.mock.calls[0]?.[0]).delivery;
                expect(delivery.kind).toBe("text");
                if (delivery.kind !== "text")
                  throw new Error("Expected informational text");
                expect(delivery.text).toContain("cannot read this media type");
              }
            }
            const files = await readdir(
              join(localRoot, tenant, "messaging", conversation),
              { recursive: true },
            ).catch(() => []);
            if (!allowed)
              expect(
                files.filter(
                  (path) =>
                    path.endsWith(".png") ||
                    path.endsWith(".mp4") ||
                    path.endsWith(".wav") ||
                    path.endsWith(".pending"),
                ),
              ).toHaveLength(0);
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
  }, 180000);
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected fixture value");
  return value;
}

async function actualLock(
  db: postgres.Sql,
  pattern: string,
  advisory = false,
): Promise<boolean> {
  for (let index = 0; index < 200; index++) {
    const rows = await db<
      { held: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND (NOT ${advisory} OR wait_event='advisory') AND query LIKE ${pattern}) AS held`;
    if (required(rows[0]).held) return true;
    await wait(10);
  }
  return false;
}
