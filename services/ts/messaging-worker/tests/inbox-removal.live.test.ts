import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  acceptWhatsAppWebhook,
  assignConversation,
  createAgentProfileDraft,
  deleteConversation,
  listAgentProfiles,
  publishAgentProfile,
  setConversationOwnership,
} from "@or-on/crm";

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
  "a removed WhatsApp conversation returns to the default AI agent",
  () => {
    const databaseName = `oron_wa_removal_${randomUUID().replaceAll("-", "")}`;
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

    it("claims an unlinked conversation for AI again after it is removed", async () => {
      const from = "12025550401";
      await customerWrites(from, "שלום");
      const first = await conversationOf(from);
      expect(first.ownership_mode).toBe("ai");

      expect(
        await asOperator((transaction) =>
          deleteConversation(transaction, first.id, userId),
        ),
      ).toMatchObject({ status: "deleted" });
      await customerWrites(from, "שלום שוב");
      const again = await conversationOf(from);
      expect(again).toMatchObject({ ownership_mode: "ai" });
    });

    it("claims an evidence-linked conversation for AI again after it is removed", async () => {
      const from = "12025550402";
      await customerWrites(from, "שלום");
      const first = await conversationOf(from);
      const contact = await admin<{ contact_id: string }[]>`
        SELECT contact_id FROM messaging.conversations WHERE id=${first.id}::uuid
      `;
      await admin`
        INSERT INTO crm.leads
          (tenant_id, reference, contact_id, source_channel, source_conversation_id)
        VALUES (${tenantId}::uuid, ${`LEAD-${randomUUID()}`},
                ${contact[0]?.contact_id ?? ""}::uuid, 'whatsapp', ${first.id}::uuid)
      `;
      // The operator took it over at some point, then removed the thread.
      expect(
        await asOperator((transaction) =>
          setConversationOwnership(transaction, first.id, userId, "human"),
        ),
      ).toBe(true);
      expect(
        await asOperator((transaction) =>
          deleteConversation(transaction, first.id, userId),
        ),
      ).toEqual({ status: "removed_retained_evidence" });

      await customerWrites(from, "שלום שוב");
      expect(await conversationOf(from)).toMatchObject({
        id: first.id,
        ownership_mode: "ai",
        assigned_user_id: null,
        handoff_reason_safe: null,
        removed_from_inbox_at: null,
      });
    });

    it("answers a reopened conversation with AI although an earlier intake was handed off", async () => {
      const from = "12025550405";
      await customerWrites(from, "שלום, יש לי תקלה");
      const first = await conversationOf(from);
      expect(first.ownership_mode).toBe("ai");
      const contact = await admin<{ contact_id: string }[]>`
        SELECT contact_id FROM messaging.conversations WHERE id=${first.id}::uuid
      `;
      // The previous episode's field-service intake ended with a person.
      await admin`
        INSERT INTO service.intake_drafts
          (tenant_id, conversation_id, reporting_contact_id, correlation_key, status)
        VALUES (${tenantId}::uuid, ${first.id}::uuid,
                ${contact[0]?.contact_id ?? ""}::uuid,
                ${`whatsapp:${first.id}:${randomUUID().replaceAll("-", "")}`},
                'handed_off')
      `;
      expect(
        await asOperator((transaction) =>
          deleteConversation(transaction, first.id, userId),
        ),
      ).toEqual({ status: "removed_retained_evidence" });

      decide.mockClear();
      await customerWrites(from, "שלום, זו פנייה חדשה");
      expect(await conversationOf(from)).toMatchObject({
        id: first.id,
        ownership_mode: "ai",
        handoff_reason_safe: null,
      });
      // The model answered the new message; nothing escalated it by itself.
      expect(decide).toHaveBeenCalled();
      const escalations = await admin<{ count: number }[]>`
        SELECT count(*)::int AS count FROM automation.handoffs
        WHERE conversation_id=${first.id}::uuid AND status IN ('pending','accepted')
      `;
      expect(escalations).toEqual([{ count: 0 }]);
    });

    it("gives the AI only the new thread after a human-handled conversation is removed", async () => {
      // Real Gemini, before this rule: the removed thread's "I want a person"
      // made the model hand the new question straight back (3 of 3 runs).
      const from = "12025550407";
      await customerWrites(from, "שלום, יש לי בעיה עם החיוב");
      await customerWrites(from, "אני רוצה לדבר עם נציג אנושי");
      const first = await conversationOf(from);
      await asOperator((transaction) =>
        setConversationOwnership(transaction, first.id, userId, "human"),
      );
      const contact = await admin<{ contact_id: string }[]>`
        SELECT contact_id FROM messaging.conversations WHERE id=${first.id}::uuid
      `;
      await admin`
        INSERT INTO crm.leads
          (tenant_id, reference, contact_id, source_channel, source_conversation_id)
        VALUES (${tenantId}::uuid, ${`LEAD-${randomUUID()}`},
                ${contact[0]?.contact_id ?? ""}::uuid, 'whatsapp', ${first.id}::uuid)
      `;
      expect(
        await asOperator((transaction) =>
          deleteConversation(transaction, first.id, userId),
        ),
      ).toEqual({ status: "removed_retained_evidence" });
      // WhatsApp timestamps have one-second precision; real removals and the
      // customer's next message are seconds to days apart.
      await new Promise((resolve) => setTimeout(resolve, 1_100));

      decide.mockClear();
      await customerWrites(from, "היי, כמה עולה המנוי החודשי?");
      const request = decide.mock.calls.at(-1)?.[0];
      expect(request?.messages.map((message) => message.text)).toEqual([
        "היי, כמה עולה המנוי החודשי?",
      ]);
      expect(await conversationOf(from)).toMatchObject({
        id: first.id,
        ownership_mode: "ai",
        handoff_reason_safe: null,
      });
    });

    it("lets an operator reassign a conversation the AI escalated to a person", async () => {
      const from = "12025550406";
      await customerWrites(from, "שלום");
      const conversation = await conversationOf(from);
      // Exactly what an AI escalation leaves: human, reason, pending handoff.
      await admin`
        UPDATE messaging.conversations
        SET ownership_mode='human', ai_agent_profile_version_id=NULL,
            ai_enabled_by_user_id=NULL, ai_enabled_at=NULL,
            handoff_reason_safe='Human review required for unavailable context'
        WHERE id=${conversation.id}::uuid
      `;
      await admin`
        INSERT INTO automation.handoffs
          (tenant_id, contact_id, conversation_id, requested_by_user_id,
           source_channel, reason_safe, status, idempotency_key)
        SELECT tenant_id, contact_id, id, ${userId}::uuid, 'whatsapp',
               'Human review required for unavailable context', 'pending',
               ${`ai-handoff:${randomUUID()}`}
        FROM messaging.conversations WHERE id=${conversation.id}::uuid
      `;
      expect(
        await asOperator((transaction) =>
          assignConversation(transaction, conversation.id, userId),
        ),
      ).toBe(true);
      expect(
        await asOperator((transaction) =>
          assignConversation(transaction, conversation.id, null),
        ),
      ).toBe(true);
      expect(
        await asOperator((transaction) =>
          setConversationOwnership(
            transaction,
            conversation.id,
            userId,
            "ai",
            agentVersionId,
          ),
        ),
      ).toBe(true);
    });

    it("in a tenant governed by the configuration baseline, uses the approved version", async () => {
      // Mirrors every tenant that existed at the 2026-09-20 upgrade: a
      // published baseline release approves versions published before it.
      await admin`
        INSERT INTO platform.tenant_configuration_releases
          (tenant_id, version, status, configuration, approved_at, review_notes)
        VALUES (${tenantId}::uuid, 1, 'published',
                ${admin.json({ schemaVersion: 1, templateKey: null, features: [], featureConfiguration: {}, processes: [] })},
                CURRENT_TIMESTAMP, 'Existing configuration preserved during platform upgrade')
        ON CONFLICT DO NOTHING
      `;
      // Editing the agent afterwards publishes v2 without an approved binding.
      const editedVersionId = await asOperator(async (transaction) => {
        const profile = await transaction<{ agent_profile_id: string }[]>`
          SELECT agent_profile_id FROM agents.agent_profile_versions
          WHERE id=${agentVersionId}::uuid
        `;
        const profileId = profile[0]?.agent_profile_id ?? "";
        await transaction`
          INSERT INTO agents.agent_profile_versions
            (tenant_id, agent_profile_id, version, system_prompt, locale,
             channel_capabilities, tool_permissions, escalation_configuration,
             validation_status, created_by_user_id)
          VALUES (platform.current_tenant_id(), ${profileId}::uuid, 2,
                  'Edited instructions after the baseline.', 'he',
                  ARRAY['whatsapp']::text[], '[]'::jsonb, '{}'::jsonb, 'valid',
                  ${userId}::uuid)
        `;
        await publishAgentProfile(transaction, userId, profileId);
        const rows = await transaction<{ id: string }[]>`
          SELECT id FROM agents.agent_profile_versions
          WHERE agent_profile_id=${profileId}::uuid AND version=2
            AND published_at IS NOT NULL
        `;
        return rows[0]?.id ?? "";
      });
      expect(editedVersionId).not.toBe("");

      const from = "12025550404";
      await customerWrites(from, "שלום");
      const claimed = await admin<{ version: string | null; mode: string }[]>`
        SELECT conversation.ownership_mode AS mode,
               conversation.ai_agent_profile_version_id AS version
        FROM messaging.conversations conversation
        JOIN crm.contact_channel_identities identity
          ON identity.contact_id=conversation.contact_id
        WHERE identity.normalized_value=${`+${from}`}
      `;
      expect(claimed).toEqual([{ mode: "ai", version: agentVersionId }]);
      // The Inbox offers exactly the version the database accepts.
      const offered = await asOperator((transaction) =>
        listAgentProfiles(transaction),
      );
      expect(
        offered.map((profile) => ({
          live: profile.publishedVersionId,
          whatsapp: profile.whatsAppAssignableVersionId,
        })),
      ).toEqual([{ live: editedVersionId, whatsapp: agentVersionId }]);

      // Live report 2026-09-21: an Inbox page opened before a release sent the
      // newest published version; the database refused it with a bare 409.
      // Handing over to the agent now binds its approved WhatsApp version.
      const conversation = await conversationOf(from);
      await asOperator((transaction) =>
        setConversationOwnership(transaction, conversation.id, userId, "human"),
      );
      expect(
        await asOperator((transaction) =>
          setConversationOwnership(
            transaction,
            conversation.id,
            userId,
            "ai",
            editedVersionId,
          ),
        ),
      ).toBe(true);
      const handedOver = await admin<
        { mode: string; version: string | null }[]
      >`
        SELECT ownership_mode AS mode, ai_agent_profile_version_id AS version
        FROM messaging.conversations WHERE id=${conversation.id}::uuid
      `;
      expect(handedOver).toEqual([{ mode: "ai", version: agentVersionId }]);

      // An agent created after the baseline, with no approved binding at all,
      // is refused with the message the Inbox explains to the operator.
      const unapprovedVersionId = await asOperator(async (transaction) => {
        const profileId = await createAgentProfileDraft(transaction, userId, {
          name: "Fictional unapproved agent",
          systemPrompt: "Answer briefly.",
          locale: "he",
          channels: ["whatsapp"],
        });
        await publishAgentProfile(transaction, userId, profileId);
        const rows = await transaction<{ id: string }[]>`
          SELECT id FROM agents.agent_profile_versions
          WHERE agent_profile_id=${profileId}::uuid AND published_at IS NOT NULL
        `;
        return rows[0]?.id ?? "";
      });
      await expect(
        asOperator((transaction) =>
          setConversationOwnership(
            transaction,
            conversation.id,
            userId,
            "ai",
            unapprovedVersionId,
          ),
        ),
      ).rejects.toThrow(
        "Approve this agent version in the workspace workflow before assignment",
      );
    });

    it("lets the operator change the responder and the assignee after reopening", async () => {
      const from = "12025550403";
      await customerWrites(from, "שלום");
      const first = await conversationOf(from);
      await asOperator((transaction) =>
        deleteConversation(transaction, first.id, userId),
      );
      await customerWrites(from, "שלום שוב");
      const reopened = await conversationOf(from);
      expect(
        await asOperator((transaction) =>
          setConversationOwnership(transaction, reopened.id, userId, "human"),
        ),
      ).toBe(true);
      expect(
        await asOperator((transaction) =>
          assignConversation(transaction, reopened.id, null),
        ),
      ).toBe(true);
      expect(
        await asOperator((transaction) =>
          assignConversation(transaction, reopened.id, userId),
        ),
      ).toBe(true);
      expect(
        await asOperator((transaction) =>
          setConversationOwnership(
            transaction,
            reopened.id,
            userId,
            "ai",
            agentVersionId,
          ),
        ),
      ).toBe(true);
    });
  },
);
