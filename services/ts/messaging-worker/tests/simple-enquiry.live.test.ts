import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  acceptWhatsAppWebhook,
  createAgentProfileDraft,
  createLeadFieldSchema,
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

const manifest = JSON.parse(
  readFileSync(
    new URL(
      "../../../../infra/tenant-configurations/oron.whatsapp-lead.agent.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  systemPrompt: string;
  capabilities: string[];
  fields: unknown;
  messages: { opening: string; name: string; phone: string; complete: string };
};

async function processUntilIdle(
  store: Readonly<{ processAvailable: () => Promise<number> }>,
  maximumPasses = 16,
): Promise<number> {
  let processed = 0;
  for (let pass = 0; pass < maximumPasses; pass += 1) {
    const current = await store.processAvailable();
    processed += current;
    if (current === 0) return processed;
  }
  throw new Error("messaging worker did not become idle");
}

describe.skipIf(sourceUrl === undefined)(
  "short Or-On enquiry workflow persists each step",
  () => {
    const databaseName = `oron_wa_lead_${randomUUID().replaceAll("-", "")}`;
    const phoneNumberId = `fixture-lead-phone-${randomUUID()}`;
    const appSecret = "fictional-whatsapp-lead-secret";
    let maintenance: postgres.Sql;
    let admin: postgres.Sql;
    let web: postgres.Sql;
    let workerUrl: string;
    const cleanup: (() => Promise<void>)[] = [];

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
        { cwd: root, env: environment, stdio: "pipe" },
      );
      execFileSync(
        "uv",
        ["run", "--no-sync", "python", "db/seeds/seed_development.py"],
        { cwd: root, env: environment, stdio: "pipe" },
      );

      admin = postgres(url.toString(), { max: 1 });
      cleanup.push(() => admin.end());
      url.searchParams.set("options", "-c role=platform_web");
      web = postgres(url.toString(), { max: 1 });
      cleanup.push(() => web.end());
      url.searchParams.set("options", "-c role=platform_messaging");
      workerUrl = url.toString();

      await admin`
        INSERT INTO messaging.channels
          (tenant_id, kind, provider, provider_account_id, display_address,
           status, configuration)
        VALUES (${tenantId}::uuid, 'whatsapp', 'meta', ${phoneNumberId},
                'Fictional lead channel', 'active',
                ${admin.json({
                  phoneNumberId,
                  wabaId: "fixture-lead-waba",
                  graphApiVersion: "v26.0",
                })})
      `;
    }, 120_000);

    afterAll(async () => {
      for (const close of cleanup.reverse()) await close();
    });

    async function acceptInbound(
      messageId: string,
      text: string,
      from: string,
    ): Promise<void> {
      const rawBody = Buffer.from(
        JSON.stringify({
          entry: [
            {
              id: "fixture-lead-waba",
              changes: [
                {
                  value: {
                    metadata: { phone_number_id: phoneNumberId },
                    contacts: [{ profile: { name: "Fictional Prospect" } }],
                    messages: [
                      {
                        id: messageId,
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
    }

    async function publishAgent(
      name: string,
      capabilities: readonly string[],
      leadFieldSchemaId?: string,
    ): Promise<string> {
      return web.begin(async (transaction) => {
        await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        await transaction`SELECT set_config('app.current_user', ${userId}, true)`;
        const profileId = await createAgentProfileDraft(transaction, userId, {
          name,
          systemPrompt: manifest.systemPrompt,
          locale: "he",
          channels: ["whatsapp"],
          toolPermissions: capabilities,
          roleTitle: "the lead coordinator",
          ...(leadFieldSchemaId === undefined ? {} : { leadFieldSchemaId }),
        });
        await publishAgentProfile(transaction, userId, profileId);
        const versions = await transaction<{ id: string }[]>`
          SELECT id FROM agents.agent_profile_versions
          WHERE agent_profile_id=${profileId}::uuid AND published_at IS NOT NULL
          ORDER BY version DESC LIMIT 1
        `;
        const versionId = versions[0]?.id;
        if (versionId === undefined)
          throw new Error(`${name} was not published`);
        return versionId;
      });
    }

    async function conversationFor(from: string): Promise<string> {
      const rows = await admin<{ id: string }[]>`
        SELECT conversation.id
        FROM messaging.conversations conversation
        JOIN crm.contact_channel_identities identity
          ON identity.contact_id=conversation.contact_id
         AND identity.channel='whatsapp'
        JOIN messaging.channels channel ON channel.id=conversation.channel_id
        WHERE channel.provider_account_id=${phoneNumberId}
          AND identity.normalized_value=${from}
        LIMIT 1
      `;
      const id = rows[0]?.id;
      if (id === undefined) throw new Error("inbound conversation was missing");
      return id;
    }

    it("captures only service, name and callback phone before the closing message", async () => {
      const schema = await web.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`;
        return createLeadFieldSchema(tx, userId, {
          name: "Fictional short enquiry",
          definition: { schemaVersion: "1.0", fields: manifest.fields },
        });
      });
      const agent = await publishAgent(
        "Fictional short enquiry",
        manifest.capabilities,
        schema.id,
      );
      const from = "12025550198";
      await acceptInbound(`wamid.bootstrap-${randomUUID()}`, "שלום", from);
      const bootstrap = createMessagingStore(
        workerUrl,
        `bootstrap-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: vi.fn(() => Promise.reject(new Error("unexpected send"))),
          },
        },
      );
      try {
        await processUntilIdle(bootstrap);
      } finally {
        await bootstrap.close();
      }
      const conversationId = await conversationFor(`+${from}`);
      await web.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`;
        await setConversationOwnership(tx, conversationId, userId, "ai", agent);
      });
      const send = vi
        .fn<(r: WhatsAppSendRequest) => Promise<WhatsAppSendResult>>()
        .mockImplementation(() =>
          Promise.resolve({ messageId: `wamid.${randomUUID()}` }),
        );
      const choose = (r: WhatsAppAiRequest): WhatsAppAiDecision => {
        expect(r.systemPrompt).toContain(manifest.systemPrompt);
        const latest = r.messages.filter((x) => x.role === "user").at(-1)?.text;
        const fields = r.lead?.collected ?? [];
        const values = Object.fromEntries(fields.map((x) => [x.key, x.value]));
        if (latest === "לא יודע" && !values.service_interest)
          return {
            action: "lead_save",
            observations: [
              {
                key: "service_interest",
                state: "known",
                value: latest,
                confirmed: true,
              },
            ],
          };
        if (latest === "דנה בדיקה" && !values.contact_name)
          return {
            action: "lead_save",
            observations: [
              {
                key: "contact_name",
                state: "known",
                value: latest,
                confirmed: true,
              },
            ],
          };
        if (latest === "+12025550199" && !values.contact_phone)
          return {
            action: "lead_save",
            observations: [
              {
                key: "contact_phone",
                state: "known",
                value: latest,
                confirmed: true,
              },
            ],
          };
        if (values.contact_phone && r.lead?.status !== "ready_for_review")
          return {
            action: "lead_finalize",
            summary:
              "שירות: לא יודע. שם: דנה בדיקה. טלפון לחזרה: +12025550199. לחזור ללקוח בהקדם.",
          };
        if (values.contact_phone) {
          expect(
            r.actionReceipts?.some((x) => x.action === "lead_finalize" && x.ok),
          ).toBe(true);
          return { action: "reply", text: manifest.messages.complete };
        }
        return {
          action: "reply",
          text: values.contact_name
            ? manifest.messages.phone
            : values.service_interest
              ? manifest.messages.name
              : manifest.messages.opening,
        };
      };
      const decide = vi.fn((r: WhatsAppAiRequest) =>
        Promise.resolve(choose(r)),
      );
      const store = createMessagingStore(
        workerUrl,
        `simple-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: { name: "meta", send },
        },
        undefined,
        { aiProvider: { decide }, realWhatsAppEnabled: true },
      );
      try {
        for (const [input, expected, count] of [
          ["היי", manifest.messages.opening, 0],
          ["לא יודע", manifest.messages.name, 1],
          ["דנה בדיקה", manifest.messages.phone, 2],
          ["+12025550199", manifest.messages.complete, 3],
        ] as const) {
          const id = `wamid.step-${randomUUID()}`;
          await acceptInbound(id, input, from);
          await processUntilIdle(store);
          const replies = await admin<
            { content_text: string }[]
          >`SELECT content_text FROM messaging.messages WHERE conversation_id=${conversationId}::uuid AND direction='outbound' ORDER BY created_at DESC LIMIT 1`;
          expect(replies[0]?.content_text).toBe(expected);
          const values = await admin<
            { field_key: string; normalized_value: string }[]
          >`SELECT field_key,normalized_value FROM crm.lead_field_values v JOIN crm.leads l ON l.id=v.lead_id WHERE l.source_conversation_id=${conversationId}::uuid AND v.superseded_at IS NULL`;
          expect(values).toHaveLength(count);
          const sent = send.mock.calls.length;
          await acceptInbound(id, input, from);
          await processUntilIdle(store);
          expect(send).toHaveBeenCalledTimes(sent);
        }
      } finally {
        await store.close();
      }
      const leads = await admin<
        { status: string; summary: string }[]
      >`SELECT status,summary FROM crm.leads WHERE source_conversation_id=${conversationId}::uuid`;
      expect(leads).toHaveLength(1);
      expect(leads[0]?.status).toBe("ready_for_review");
      expect(leads[0]?.summary).toContain("+12025550199");
      const identity = await admin<
        { normalized_value: string }[]
      >`SELECT normalized_value FROM crm.contact_channel_identities i JOIN messaging.conversations c ON c.contact_id=i.contact_id WHERE c.id=${conversationId}::uuid AND i.channel='whatsapp'`;
      expect(identity.map((x) => x.normalized_value)).toContain(`+${from}`);
      expect(identity.map((x) => x.normalized_value)).not.toContain(
        "+12025550199",
      );
    }, 120_000);
  },
);
