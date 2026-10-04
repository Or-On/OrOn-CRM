function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing synthetic fixture value");
  return value;
}
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  acceptWhatsAppWebhook,
  createAgentProfileDraft,
  publishAgentProfile,
  setConversationOwnership,
} from "@or-on/crm";
import {
  deleteConversation,
  ingestWhatsAppInbound,
} from "../../../../packages/ts/crm/src/messaging.js";

import { createMessagingStore } from "../src/database.js";
import type {
  WhatsAppAiDecision,
  WhatsAppAiRequest,
} from "../src/ai-provider.js";
import {
  SimulatorWhatsAppProvider,
  type WhatsAppSendRequest,
  type WhatsAppSendResult,
} from "../src/providers.js";

const sourceUrl = process.env.CROSS_CHANNEL_TEST_DATABASE_URL;
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";

async function processUntilIdle(
  store: Readonly<{ processAvailable: () => Promise<number> }>,
): Promise<void> {
  for (let pass = 0; pass < 16; pass += 1)
    if ((await store.processAvailable()) === 0) return;
  throw new Error("messaging worker did not become idle");
}

/**
 * The operator's lifecycle, end to end: a customer writes, the tenant's default
 * WhatsApp agent answers, the operator removes the conversation from the Inbox,
 * the customer writes again. The real webhook intake, worker and CRM mutations
 * run against PostgreSQL; only the AI decision and Meta HTTP are fixtures.
 */
describe.skipIf(sourceUrl === undefined)(
  "remediation evidence survives Inbox removal and reopens safely",
  () => {
    const databaseName = `oron_retention_${randomUUID().replaceAll("-", "")}`;
    const phoneNumberId = `fixture-removal-phone-${randomUUID()}`;
    const appSecret = "fictional-whatsapp-removal-secret";
    let maintenance: postgres.Sql;
    let admin: postgres.Sql;
    let web: postgres.Sql;
    let workerUrl: string;
    let agentVersionId: string;
    const cleanup: (() => Promise<void>)[] = [];
    const decide = vi
      .fn<(request: WhatsAppAiRequest) => Promise<WhatsAppAiDecision>>()
      .mockResolvedValue({ action: "reply", text: "שלום, איך אפשר לעזור?" });

    beforeAll(async () => {
      if (sourceUrl === undefined)
        throw new Error("explicit PostgreSQL test URL required");
      const url = new URL(sourceUrl);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        throw new Error("isolated worker tests require localhost PostgreSQL");
      url.pathname = "/postgres";
      maintenance = postgres(url.toString(), { max: 1 });
      cleanup.push(() => maintenance.end());
      await maintenance.unsafe(`CREATE DATABASE "${databaseName}"`);
      cleanup.push(async () => {
        await maintenance.unsafe(
          `DROP DATABASE "${databaseName}" WITH (FORCE)`,
        );
      });
      url.pathname = `/${databaseName}`;
      const environment = {
        ...process.env,
        DATABASE_URL: url.toString(),
        ENABLE_REAL_WHATSAPP: "false",
        ENABLE_REAL_TELEPHONY: "false",
        WHATSAPP_ACCESS_TOKEN: "",
        WHATSAPP_APP_SECRET: "",
        DEV_AUTH_EMAIL: "operator@or-on.local",
        DEV_AUTH_PASSWORD_HASH: "$argon2id$isolated-test-not-a-login-hash",
      };
      for (const args of [
        ["run", "--no-sync", "alembic", "-c", "db/alembic/alembic.ini"].concat([
          "upgrade",
          "head",
        ]),
        ["run", "--no-sync", "python", "db/seeds/seed_development.py"],
      ])
        execFileSync("uv", args, {
          cwd: root,
          env: environment,
          stdio: "pipe",
        });

      admin = postgres(url.toString(), { max: 1 });
      cleanup.push(() => admin.end());
      url.searchParams.set("options", "-c role=platform_web");
      web = postgres(url.toString(), { max: 1 });
      cleanup.push(() => web.end());
      url.searchParams.set("options", "-c role=platform_messaging");
      workerUrl = url.toString();

      for (const feature of ["whatsapp", "agents"])
        await admin`
          INSERT INTO platform.tenant_feature_entitlements
            (tenant_id, feature_key, available, enabled, granted_by_user_id, granted_at)
          VALUES (${tenantId}::uuid, ${feature}, true, true, ${userId}::uuid, CURRENT_TIMESTAMP)
          ON CONFLICT (tenant_id, feature_key)
          DO UPDATE SET available = true, enabled = true
        `;
      await admin`
        INSERT INTO messaging.channels
          (tenant_id, kind, provider, provider_account_id, display_address,
           status, configuration)
        VALUES (${tenantId}::uuid, 'whatsapp', 'meta', ${phoneNumberId},
                'Fictional removal channel', 'active',
                ${admin.json({
                  phoneNumberId,
                  wabaId: "fixture-removal-waba",
                  graphApiVersion: "v26.0",
                })})
      `;
      agentVersionId = await asOperator(async (transaction) => {
        const profileId = await createAgentProfileDraft(transaction, userId, {
          name: "Fictional support agent",
          systemPrompt: "Answer the customer's WhatsApp questions briefly.",
          locale: "he",
          channels: ["whatsapp"],
        });
        // The first published WhatsApp agent becomes the tenant default.
        await publishAgentProfile(transaction, userId, profileId);
        const rows = await transaction<{ id: string }[]>`
          SELECT id FROM agents.agent_profile_versions
          WHERE agent_profile_id=${profileId}::uuid AND published_at IS NOT NULL
        `;
        const id = rows[0]?.id;
        if (id === undefined) throw new Error("agent was not published");
        return id;
      });
    }, 180_000);

    afterAll(async () => {
      for (const close of cleanup.reverse()) await close();
    });

    function asOperator<T>(
      work: (transaction: postgres.TransactionSql) => Promise<T>,
    ): Promise<T> {
      // postgres.js types `begin` as UnwrapPromiseArray<T>; T is never an array here.
      return web.begin(async (transaction) => {
        await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        await transaction`SELECT set_config('app.current_user', ${userId}, true)`;
        await transaction`SELECT set_config('app.current_role', 'owner', true)`;
        return work(transaction);
      }) as Promise<T>;
    }

    async function customerWrites(from: string, text: string): Promise<void> {
      const rawBody = Buffer.from(
        JSON.stringify({
          entry: [
            {
              id: "fixture-removal-waba",
              changes: [
                {
                  value: {
                    metadata: { phone_number_id: phoneNumberId },
                    contacts: [{ profile: { name: "Fictional Customer" } }],
                    messages: [
                      {
                        id: `wamid.removal-${randomUUID()}`,
                        from,
                        type: "text",
                        timestamp: String(Math.floor(Date.now() / 1000)),
                        text: { body: text },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      );
      const signature = `sha256=${createHmac("sha256", appSecret)
        .update(rawBody)
        .digest("hex")}`;
      await acceptWhatsAppWebhook(workerUrl, rawBody, signature, appSecret);
      const store = createMessagingStore(
        workerUrl,
        `removal-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: vi
              .fn<
                (request: WhatsAppSendRequest) => Promise<WhatsAppSendResult>
              >()
              .mockImplementation(() =>
                Promise.resolve({ messageId: `wamid.${randomUUID()}` }),
              ),
          },
        },
        undefined,
        { aiProvider: { decide }, realWhatsAppEnabled: true },
      );
      try {
        await processUntilIdle(store);
      } finally {
        await store.close();
      }
    }

    async function conversationOf(from: string) {
      const rows = await admin<
        {
          id: string;
          ownership_mode: string;
          assigned_user_id: string | null;
          handoff_reason_safe: string | null;
          removed_from_inbox_at: Date | null;
        }[]
      >`
        SELECT conversation.id, conversation.ownership_mode,
               conversation.assigned_user_id, conversation.handoff_reason_safe,
               conversation.removed_from_inbox_at
        FROM messaging.conversations conversation
        JOIN crm.contact_channel_identities identity
          ON identity.contact_id=conversation.contact_id
         AND identity.channel='whatsapp'
        WHERE identity.normalized_value=${`+${from}`}
      `;
      const [conversation, ...others] = rows;
      if (conversation === undefined || others.length > 0)
        throw new Error("expected exactly one conversation for the customer");
      return conversation;
    }

    it.each([
      "none",
      "unadmitted",
      "memory",
      "audio",
      "model",
      "admitted",
    ] as const)(
      "retains %s evidence and reopens through signed ingress",
      async (kind) => {
        const kinds = [
          "none",
          "unadmitted",
          "memory",
          "audio",
          "model",
          "admitted",
        ];
        const from = `120255507${String(kinds.indexOf(kind) + 10).padStart(2, "0")}`;
        const initial = await admin.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.current_user',${userId},true),set_config('app.current_role','owner',true)`;
          return ingestWhatsAppInbound(tx, {
            providerAccountId: phoneNumberId,
            providerEventId: randomUUID(),
            providerMessageId: `wamid.initial-${randomUUID()}`,
            from: `+${from}`,
            profileName: "Fictional retained customer",
            text: "Fictional original message",
            occurredAt: new Date().toISOString(),
          });
        });
        expect(initial.messageId).toBeDefined();
        await asOperator((tx) =>
          setConversationOwnership(
            tx,
            initial.conversationId,
            userId,
            "ai",
            agentVersionId,
          ),
        );
        const job = randomUUID(),
          object = randomUUID(),
          operation = randomUUID(),
          file = randomUUID(),
          remoteJob = randomUUID();
        if (kind === "memory")
          await admin`INSERT INTO agents.messaging_memory_sessions(tenant_id,conversation_id,agent_version_id) VALUES(${tenantId}::uuid,${initial.conversationId}::uuid,${agentVersionId}::uuid)`;
        if (["audio", "model", "admitted", "unadmitted"].includes(kind)) {
          await admin`INSERT INTO ops.jobs(id,tenant_id,queue,job_type,reference_type,reference_id,payload,status,completed_at,admitted_agent_version_id)
          VALUES(${job}::uuid,${tenantId}::uuid,'messaging',${kind === "audio" ? "whatsapp.audio.transcribe" : "whatsapp.ai.reply"},${kind === "audio" ? "message" : "conversation"},${kind === "audio" ? required(initial.messageId) : initial.conversationId}::uuid,'{}'::jsonb,'succeeded',clock_timestamp(),${kind === "model" || kind === "admitted" ? agentVersionId : null}::uuid)`;
        }
        if (kind === "model")
          await admin`INSERT INTO agents.model_attempts(id,tenant_id,job_id,agent_version_id,model,occurred_at,latency_ms,status) VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${job}::uuid,${agentVersionId}::uuid,'fictional-model',clock_timestamp(),1,'timeout')`;
        if (kind === "audio") {
          await admin`INSERT INTO objects.object_metadata(id,tenant_id,created_by_user_id,owner_type,owner_id,category,content_type,byte_size,checksum,storage_backend,storage_key,status) VALUES(${object}::uuid,${tenantId}::uuid,${userId}::uuid,'message',${required(initial.messageId)}::uuid,'whatsapp_media','audio/ogg',1,'fictional-checksum','local',${`fictional/${object}`},'available')`;
          await admin`UPDATE messaging.messages SET content_type='audio',object_id=${object}::uuid WHERE id=${required(initial.messageId)}::uuid`;
          await admin`INSERT INTO messaging.audio_transcription_work(operation_id,tenant_id,message_id,object_id,job_id,sha256,phase,file_id,provider_job_id,transcript,cleanup) VALUES(${operation}::uuid,${tenantId}::uuid,${required(initial.messageId)}::uuid,${object}::uuid,${job}::uuid,${"a".repeat(64)},'completed',${file}::uuid,${remoteJob}::uuid,'Fictional audio transcript','blocked')`;
        }
        const oldEpoch = required(
          (
            await admin<
              { epoch: string }[]
            >`SELECT ownership_epoch::text epoch FROM messaging.conversations WHERE id=${initial.conversationId}::uuid`
          )[0],
        ).epoch;
        const removed = await asOperator((tx) =>
          deleteConversation(tx, initial.conversationId, userId),
        );
        const retained = kind !== "none" && kind !== "unadmitted";
        expect(removed.status).toBe(
          retained ? "removed_retained_evidence" : "deleted",
        );
        const remaining = await admin<
          { removed: boolean; epoch: string }[]
        >`SELECT removed_from_inbox_at IS NOT NULL removed,ownership_epoch::text epoch FROM messaging.conversations WHERE id=${initial.conversationId}::uuid`;
        if (retained) {
          expect(remaining).toHaveLength(1);
          expect(required(remaining[0]).removed).toBe(true);
          expect(Number(required(remaining[0]).epoch)).toBeGreaterThan(
            Number(oldEpoch),
          );
          expect(
            await asOperator((tx) =>
              deleteConversation(tx, initial.conversationId, userId),
            ),
          ).toEqual({ status: "removed_retained_evidence" });
          expect(
            await admin<
              { count: number }[]
            >`SELECT count(*)::int count FROM audit.records WHERE action='conversation.removed_from_inbox' AND target_id=${initial.conversationId}::uuid`,
          ).toEqual([{ count: 1 }]);
        } else expect(remaining).toHaveLength(0);
        if (kind === "audio")
          expect(
            await admin`SELECT file_id,provider_job_id,cleanup FROM messaging.audio_transcription_work WHERE operation_id=${operation}::uuid`,
          ).toEqual([
            { file_id: file, provider_job_id: remoteJob, cleanup: "blocked" },
          ]);
        if (kind === "memory")
          expect(
            await admin`SELECT id FROM agents.messaging_memory_sessions WHERE conversation_id=${initial.conversationId}::uuid`,
          ).toHaveLength(1);
        if (kind === "model")
          expect(
            await admin`SELECT id FROM agents.model_attempts WHERE job_id=${job}::uuid`,
          ).toHaveLength(1);
        await customerWrites(from, "I need help with a repair.");
        const reopened = await conversationOf(from);
        expect(reopened.ownership_mode).toBe("ai");
        expect(reopened.removed_from_inbox_at).toBeNull();
        if (retained) expect(reopened.id).toBe(initial.conversationId);
        else expect(reopened.id).not.toBe(initial.conversationId);
      },
    );
    it("returns false for foreign evidence and denies viewer deletion", async () => {
      const foreign = randomUUID(),
        convo = randomUUID(),
        contact = randomUUID(),
        channel = randomUUID(),
        viewer = randomUUID();
      await admin`INSERT INTO tenants(id,name,slug,status) VALUES(${foreign}::uuid,'Fictional foreign',${`foreign-${foreign}`},'active')`;
      await admin`INSERT INTO crm.contacts(id,tenant_id,name) VALUES(${contact}::uuid,${foreign}::uuid,'Foreign fixture')`;
      await admin`INSERT INTO messaging.channels(id,tenant_id,kind,provider,status) VALUES(${channel}::uuid,${foreign}::uuid,'whatsapp','simulator','active')`;
      await admin`INSERT INTO messaging.conversations(id,tenant_id,contact_id,channel_id,status) VALUES(${convo}::uuid,${foreign}::uuid,${contact}::uuid,${channel}::uuid,'open')`;
      expect(
        await asOperator(
          (tx) =>
            tx`SELECT platform.conversation_has_remediation_evidence(${convo}::uuid) found`,
        ),
      ).toEqual([{ found: false }]);
      expect(
        await asOperator((tx) => deleteConversation(tx, convo, userId)),
      ).toEqual({ status: "not_found" });
      await admin`INSERT INTO users(id,email,display_name,status) VALUES(${viewer}::uuid,${`${viewer}@example.invalid`},'Fictional viewer','active')`;
      await admin`INSERT INTO memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${viewer}::uuid,'viewer')`;
      const own = required(
        (
          await admin<
            { id: string }[]
          >`SELECT id FROM messaging.conversations WHERE tenant_id=${tenantId}::uuid ORDER BY created_at DESC LIMIT 1`
        )[0],
      ).id;
      await expect(
        web.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.current_user',${viewer},true),set_config('app.current_role','owner',true)`;
          return deleteConversation(tx, own, viewer);
        }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        web.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.current_user',${viewer},true),set_config('app.current_role','owner',true)`;
          return deleteConversation(tx, own, userId);
        }),
      ).rejects.toMatchObject({ code: "42501" });
      await admin`UPDATE users SET status='disabled' WHERE id=${userId}::uuid`;
      try {
        await expect(
          asOperator((tx) => deleteConversation(tx, own, userId)),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await admin`UPDATE users SET status='active' WHERE id=${userId}::uuid`;
      }
      await admin`UPDATE tenants SET status='inactive' WHERE id=${tenantId}::uuid`;
      try {
        await expect(
          asOperator((tx) => deleteConversation(tx, own, userId)),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await admin`UPDATE tenants SET status='active' WHERE id=${tenantId}::uuid`;
      }
      expect(
        await admin`SELECT id FROM messaging.conversations WHERE id=${own}::uuid AND removed_from_inbox_at IS NULL`,
      ).toHaveLength(1);
    });
  },
);
