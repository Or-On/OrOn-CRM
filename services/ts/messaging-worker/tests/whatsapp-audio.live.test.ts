import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres from "postgres";
import { acceptWhatsAppWebhook } from "@or-on/crm";
import { describe, it, expect, vi } from "vitest";
import { createMessagingStore } from "../src/database.js";
import { SimulatorWhatsAppProvider } from "../src/providers.js";
import type { WhatsAppAiProvider } from "../src/ai-provider.js";
import type { AudioTranscriber } from "../src/audio-transcription.js";

const url = process.env.CRM_TEST_DATABASE_URL;
describe.skipIf(!url)(
  "actual worker durable audio with synthetic provider",
  () => {
    async function fixture(human = false) {
      if (!url) throw new Error("Explicit fixture URL required");
      const target = new URL(url);
      if (
        target.hostname !== "127.0.0.1" ||
        target.port !== "55480" ||
        !/^\/oron_(?:crm|ui_preview)_[a-f0-9]{32}$/u.test(target.pathname)
      )
        throw new Error("owned synthetic fixture required");
      const db = postgres(url, { max: 1, prepare: false });
      let fixtureRoot: string | undefined;
      try {
        // Independent from file order: every scenario owns its fictional
        // tenant and published agent rather than borrowing a prior suite's.
        const agent = {
          id: randomUUID(),
          tenant_id: randomUUID(),
          user_id: randomUUID(),
        };
        const profile = randomUUID();
        await db`INSERT INTO tenants(id,name,slug,status) VALUES(${agent.tenant_id}::uuid,'Fictional audio tenant',${agent.tenant_id},'active')`;
        await db`INSERT INTO users(id,email,status) VALUES(${agent.user_id}::uuid,${`${agent.user_id}@example.invalid`},'active')`;
        await db`INSERT INTO memberships(tenant_id,user_id,role) VALUES(${agent.tenant_id}::uuid,${agent.user_id}::uuid,'owner')`;
        await db`SELECT set_config('app.current_tenant',${agent.tenant_id},false)`;
        await db`INSERT INTO crm.tenant_settings(tenant_id,locale,timezone) VALUES(${agent.tenant_id}::uuid,'en','UTC')`;
        await db`UPDATE platform.tenant_feature_entitlements SET available=true,enabled=true,granted_at=clock_timestamp()
          WHERE tenant_id=${agent.tenant_id}::uuid AND feature_key IN ('agents','contacts','whatsapp')`;
        await db`INSERT INTO agents.agent_profiles(id,tenant_id,name) VALUES(${profile}::uuid,${agent.tenant_id}::uuid,'Fictional audio agent')`;
        await db`INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,system_prompt,locale,
          channel_capabilities,tool_permissions,validation_status,published_at)
          VALUES(${agent.id}::uuid,${agent.tenant_id}::uuid,${profile}::uuid,1,'Answer synthetic audio safely.','en',
          ARRAY['whatsapp'],'[]'::jsonb,'valid',clock_timestamp())`;
        const contact = randomUUID(),
          channel = randomUUID(),
          conversation = randomUUID(),
          message = randomUUID(),
          object = randomUUID(),
          operation = randomUUID();
        const root = await mkdtemp(join(tmpdir(), "audio-worker-fixture-"));
        fixtureRoot = root;
        const bytes = Buffer.from("synthetic private audio");
        const sha = createHash("sha256").update(bytes).digest("hex");
        await writeFile(join(root, `${object}.wav`), bytes);
        await db`INSERT INTO crm.contacts(id,tenant_id,name,whatsapp_consent) VALUES(${contact}::uuid,${agent.tenant_id}::uuid,'Fictional audio contact','granted')`;
        await db`INSERT INTO messaging.channels(id,tenant_id,kind,provider,provider_account_id,status,configuration) VALUES(${channel}::uuid,${agent.tenant_id}::uuid,'whatsapp','meta',${channel},'active',${db.json({ phoneNumberId: channel, wabaId: "fictional-audio-waba", graphApiVersion: "v26.0" })})`;
        await db`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,status,ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at,customer_service_window_expires_at) VALUES(${conversation}::uuid,${agent.tenant_id}::uuid,${channel}::uuid,${contact}::uuid,'open',${human ? "human" : "ai"},${agent.id}::uuid,${agent.user_id}::uuid,clock_timestamp(),clock_timestamp()+interval '24 hours')`;
        await db`INSERT INTO objects.object_metadata(id,tenant_id,owner_type,owner_id,category,content_type,byte_size,checksum,storage_backend,storage_key,status) VALUES(${object}::uuid,${agent.tenant_id}::uuid,'message',${message}::uuid,'whatsapp_customer_audio','audio/wav',${bytes.length},${sha},'local',${`${object}.wav`},'available')`;
        await db`INSERT INTO messaging.messages(id,tenant_id,conversation_id,direction,sender_type,content_type,provider,provider_message_id,status,object_id,structured_content) VALUES(${message}::uuid,${agent.tenant_id}::uuid,${conversation}::uuid,'inbound','contact','audio','meta',${message},'received',${object}::uuid,'{"transcriptionStatus":"pending"}')`;
        const identity = randomUUID();
        const [available] = await db<
          { address: string }[]
        >`SELECT '+120255501'||lpad(number::text,2,'0') address FROM generate_series(0,99) number WHERE NOT EXISTS(SELECT 1 FROM crm.contact_channel_identities identity WHERE identity.tenant_id=${agent.tenant_id}::uuid AND identity.normalized_value='+120255501'||lpad(number::text,2,'0')) ORDER BY number LIMIT 1`;
        if (!available)
          throw new Error("Synthetic reserved phone range exhausted");
        const address = available.address;
        await db`INSERT INTO crm.contact_channel_identities(id,tenant_id,contact_id,channel,normalized_value,display_value,provider,provider_identity_id,validation_status,is_primary) VALUES(${identity}::uuid,${agent.tenant_id}::uuid,${contact}::uuid,'whatsapp',${address},${address},'meta',${address},'valid',true)`;
        await db`INSERT INTO messaging.inbound_message_origins(tenant_id,message_id,contact_identity_id,sender_address) VALUES(${agent.tenant_id}::uuid,${message}::uuid,${identity}::uuid,${address})`;
        for (const flag of ["audio_transcription", "no_silence"])
          await db`INSERT INTO platform.tenant_remediation_flags(tenant_id,flag_key,enabled) VALUES(${agent.tenant_id}::uuid,${flag},true) ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=true`;
        const payload = {
          operationId: operation,
          messageId: message,
          objectId: object,
          sha256: sha,
          conversationId: conversation,
          triggerMessageId: message,
        };
        await db`INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,max_attempts,priority) VALUES(${agent.tenant_id}::uuid,'messaging','whatsapp.audio.transcribe','conversation',${conversation}::uuid,${db.json(payload)},${`audio:${operation}`},20,100)`;
        const workerUrl = new URL(url);
        workerUrl.searchParams.set("options", "-c role=platform_messaging");
        return {
          db,
          root,
          conversation,
          message,
          operation,
          channel,
          address,
          workerUrl: workerUrl.toString(),
          async close() {
            // Admissions and outbound authority retain these canonical job IDs.
            // Preserve completed/running history; only postpone our queued work so
            // the following synthetic scenario cannot claim this fixture's jobs.
            try {
              await db`UPDATE ops.jobs SET available_at=clock_timestamp()+interval '1 day' WHERE tenant_id=${agent.tenant_id}::uuid AND (reference_id=${conversation}::uuid OR payload->>'conversationId'=${conversation}) AND status='queued'`;
            } finally {
              try {
                await db.end();
              } finally {
                await rm(root, { recursive: true, force: true });
              }
            }
          },
        };
      } catch (error) {
        // Setup can fail before fixture() returns and before the test finally exists.
        const results = await Promise.allSettled([
          db.end(),
          ...(fixtureRoot
            ? [rm(fixtureRoot, { recursive: true, force: true })]
            : []),
        ]);
        const cleanupErrors: unknown[] = [];
        for (const result of results) {
          if (result.status === "rejected") {
            const reason: unknown = result.reason;
            cleanupErrors.push(reason);
          }
        }
        if (cleanupErrors.length)
          throw new AggregateError(
            [error, ...cleanupErrors],
            "Synthetic fixture setup and cleanup failed",
            { cause: error },
          );
        throw error;
      }
    }
    const providers = {
      simulator: new SimulatorWhatsAppProvider(),
      meta: {
        name: "meta" as const,
        send: vi.fn(() => Promise.reject(new Error("no real send"))),
      },
    };
    it("publishes actual transcript and queues exactly one AI reply", async () => {
      const f = await fixture();
      const start = vi.fn<AudioTranscriber["start"]>(async (input) => {
        await input.beforeAttempt();
        await input.checkpoint({
          phase: "upload_inflight",
          operationId: input.operationId,
        });
        const fileId = randomUUID();
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
          text: "Fictional actual customer transcript",
        };
      });
      const decide = vi.fn<WhatsAppAiProvider["decide"]>(() =>
        Promise.resolve({
          action: "reply",
          text: "Is the router light blinking?",
        }),
      );
      const store = createMessagingStore(
        f.workerUrl,
        randomUUID(),
        providers,
        undefined,
        {
          realWhatsAppEnabled: true,
          privateObjectStorage: { localRoot: f.root },
          audioTranscriber: { start, poll: vi.fn() },
          aiProvider: { decide },
        },
      );
      try {
        for (let pass = 0; pass < 4 && start.mock.calls.length === 0; pass++)
          await store.processAvailable();
        const [row] = await f.db<
          { content_text: string }[]
        >`SELECT content_text FROM messaging.messages WHERE id=${f.message}::uuid`;
        expect(row?.content_text).toBe("Fictional actual customer transcript");
        const [count] = await f.db<
          { n: number }[]
        >`SELECT count(*)::int n FROM ops.jobs WHERE reference_id=${f.conversation}::uuid AND job_type='whatsapp.ai.reply'`;
        expect(count?.n).toBe(1);
        expect(start).toHaveBeenCalledOnce();
        for (let pass = 0; pass < 4 && decide.mock.calls.length === 0; pass++)
          await store.processAvailable();
        expect(decide).toHaveBeenCalledOnce();
        expect(JSON.stringify(decide.mock.calls[0]?.[0])).toContain(
          "Fictional actual customer transcript",
        );
        const [reply] = await f.db<
          { n: number }[]
        >`SELECT count(*)::int n FROM messaging.messages WHERE conversation_id=${f.conversation}::uuid AND direction='outbound'`;
        expect(reply?.n).toBe(1);
        const [retained] = await f.db<{ n: number }[]>`
          SELECT count(*)::int n FROM agents.messaging_session_admissions admission
          JOIN ops.jobs job ON job.id=admission.job_id
          WHERE job.tenant_id=(SELECT tenant_id FROM messaging.conversations WHERE id=${f.conversation}::uuid)
            AND job.reference_id=${f.conversation}::uuid
        `;
        expect(retained?.n).toBeGreaterThan(0);
      } finally {
        try {
          await store.close();
        } finally {
          await f.close();
        }
      }
    });
    it("human takeover prevents provider start and transcript writes", async () => {
      const f = await fixture(true);
      const start = vi.fn<AudioTranscriber["start"]>();
      const store = createMessagingStore(
        f.workerUrl,
        randomUUID(),
        providers,
        undefined,
        {
          realWhatsAppEnabled: true,
          audioTranscriber: { start, poll: vi.fn() },
        },
      );
      try {
        await store.processAvailable();
        expect(start).not.toHaveBeenCalled();
        const [row] = await f.db<
          { content_text: string | null }[]
        >`SELECT content_text FROM messaging.messages WHERE id=${f.message}::uuid`;
        expect(row?.content_text).toBeNull();
      } finally {
        try {
          await store.close();
        } finally {
          await f.close();
        }
      }
    });
    it("missing provider creates one fallback, task and operator alert job", async () => {
      const f = await fixture();
      const store = createMessagingStore(
        f.workerUrl,
        randomUUID(),
        providers,
        undefined,
        { realWhatsAppEnabled: true },
      );
      try {
        const appSecret = "fictional-audio-signature-secret";
        const raw = Buffer.from(
          JSON.stringify({
            entry: [
              {
                id: "fictional-audio-waba",
                changes: [
                  {
                    value: {
                      metadata: { phone_number_id: f.channel },
                      messages: [
                        {
                          id: f.message,
                          from: f.address.slice(1),
                          type: "audio",
                          timestamp: String(Math.floor(Date.now() / 1000)),
                          audio: {
                            id: "fixture-media-only",
                            mime_type: "audio/wav",
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
        const signature = `sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`;
        await acceptWhatsAppWebhook(f.workerUrl, raw, signature, appSecret);
        await acceptWhatsAppWebhook(f.workerUrl, raw, signature, appSecret);
        await store.processAvailable();
        const [state] = await f.db<
          { phase: string; terminal_handled: boolean }[]
        >`SELECT phase,terminal_handled FROM messaging.audio_transcription_work WHERE operation_id=${f.operation}::uuid`;
        expect(state).toMatchObject({
          phase: "failed",
          terminal_handled: true,
        });
        const [task] = await f.db<
          { n: number }[]
        >`SELECT count(*)::int n FROM crm.tasks WHERE contact_id=(SELECT contact_id FROM messaging.conversations WHERE id=${f.conversation}::uuid)`;
        expect(task?.n).toBe(1);
        const [out] = await f.db<
          { n: number }[]
        >`SELECT count(*)::int n FROM messaging.messages WHERE conversation_id=${f.conversation}::uuid AND direction='outbound'`;
        expect(out?.n).toBe(1);
        const [alerts] = await f.db<
          { n: number }[]
        >`SELECT count(*)::int n FROM ops.jobs WHERE payload->>'conversationId'=${f.conversation} AND job_type='whatsapp.operator.alert'`;
        expect(alerts?.n).toBe(1);
      } finally {
        try {
          await store.close();
        } finally {
          await f.close();
        }
      }
    });

    it("poll rescheduling resumes checkpoint without submitting duplicate audio", async () => {
      const f = await fixture();
      const ticket = {
        operationId: f.operation,
        fileId: randomUUID(),
        providerJobId: randomUUID(),
      };
      const start = vi.fn<AudioTranscriber["start"]>(async (input) => {
        await input.beforeAttempt();
        await input.checkpoint({
          phase: "upload_inflight",
          operationId: input.operationId,
        });
        await input.checkpoint({
          phase: "uploaded",
          operationId: input.operationId,
          fileId: ticket.fileId,
        });
        await input.checkpoint({
          phase: "submit_inflight",
          operationId: input.operationId,
          fileId: ticket.fileId,
        });
        await input.checkpoint({ phase: "submitted", ticket });
        return { kind: "pending", ticket, retryAfterMs: 1 };
      });
      const poll = vi.fn<AudioTranscriber["poll"]>(async (t, before) => {
        await before();
        return {
          kind: "completed",
          ticket: t,
          text: "Fictional polled transcript",
        };
      });
      const store = createMessagingStore(
        f.workerUrl,
        randomUUID(),
        providers,
        undefined,
        {
          realWhatsAppEnabled: true,
          privateObjectStorage: { localRoot: f.root },
          audioTranscriber: { start, poll },
        },
      );
      try {
        for (let pass = 0; pass < 4 && start.mock.calls.length === 0; pass++)
          await store.processAvailable();
        const [queued] = await f.db<
          { status: string }[]
        >`SELECT status FROM ops.jobs WHERE payload->>'operationId'=${f.operation}`;
        expect(queued?.status).toBe("queued");
        await f.db`UPDATE ops.jobs SET available_at=clock_timestamp()-interval '1 second' WHERE payload->>'operationId'=${f.operation}`;
        await f.db`UPDATE messaging.audio_transcription_work SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE operation_id=${f.operation}::uuid`;
        for (let pass = 0; pass < 5 && poll.mock.calls.length === 0; pass++)
          await store.processAvailable();
        expect(start).toHaveBeenCalledOnce();
        expect(poll).toHaveBeenCalledOnce();
        const [row] = await f.db<
          { content_text: string }[]
        >`SELECT content_text FROM messaging.messages WHERE id=${f.message}::uuid`;
        expect(row?.content_text).toBe("Fictional polled transcript");
        const [count] = await f.db<
          { n: number }[]
        >`SELECT count(*)::int n FROM ops.jobs WHERE reference_id=${f.conversation}::uuid AND job_type='whatsapp.ai.reply'`;
        expect(count?.n).toBe(1);
      } finally {
        try {
          await store.close();
        } finally {
          await f.close();
        }
      }
    });

    it("a replaced claim cannot publish a late transcript or finish the new owner job", async () => {
      const f = await fixture();
      const start = vi.fn<AudioTranscriber["start"]>(async (input) => {
        await input.beforeAttempt();
        await input.checkpoint({
          phase: "upload_inflight",
          operationId: input.operationId,
        });
        const fileId = randomUUID();
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
        await f.db`UPDATE ops.jobs SET claim_token=${randomUUID()}::uuid,locked_by='synthetic-new-owner' WHERE payload->>'operationId'=${f.operation}`;
        return { kind: "completed", ticket, text: "Forbidden late transcript" };
      });
      const store = createMessagingStore(
        f.workerUrl,
        randomUUID(),
        providers,
        undefined,
        {
          realWhatsAppEnabled: true,
          privateObjectStorage: { localRoot: f.root },
          audioTranscriber: { start, poll: vi.fn() },
        },
      );
      try {
        for (let pass = 0; pass < 4 && start.mock.calls.length === 0; pass++) {
          try {
            await store.processAvailable();
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toContain("stale_worker_claim");
          }
        }
        expect(start).toHaveBeenCalledOnce();
        const [row] = await f.db<
          { content_text: string | null }[]
        >`SELECT content_text FROM messaging.messages WHERE id=${f.message}::uuid`;
        expect(row?.content_text).toBeNull();
        const [job] = await f.db<
          { status: string; locked_by: string }[]
        >`SELECT status,locked_by FROM ops.jobs WHERE payload->>'operationId'=${f.operation}`;
        expect(job).toMatchObject({
          status: "running",
          locked_by: "synthetic-new-owner",
        });
        const [count] = await f.db<
          { n: number }[]
        >`SELECT count(*)::int n FROM ops.jobs WHERE reference_id=${f.conversation}::uuid AND job_type='whatsapp.ai.reply'`;
        expect(count?.n).toBe(0);
      } finally {
        try {
          await store.close();
        } finally {
          await f.close();
        }
      }
    });
  },
);
