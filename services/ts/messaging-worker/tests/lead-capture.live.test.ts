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

/**
 * The lead coordinator's reviewed field list. Deliberately not the support
 * intake's fields: a lead agent asks its own questions.
 */
const coordinatorFields = {
  schemaVersion: "1.0",
  fields: [
    {
      key: "preferred_name",
      label: "Preferred name",
      type: "text",
      required: true,
    },
    { key: "company", label: "Company", type: "text", required: true },
    {
      key: "seat_count",
      label: "Number of users",
      type: "number",
      required: false,
    },
    { key: "budget", label: "Budget", type: "currency", required: false },
  ],
} as const;

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
  "a published lead agent captures on WhatsApp",
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
          systemPrompt:
            "You are the Hebrew-speaking lead coordinator for the configured " +
            "business. Collect the customer's preferred name, company, " +
            "approximate number of users and budget when they choose to share " +
            "them. Save confirmed information using enabled lead actions and " +
            "only acknowledge successful saves.",
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

    it("saves, finalizes and records requested follow-up before replying, then reloads the completed state", async () => {
      const schema = await web.begin(async (transaction) => {
        await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        await transaction`SELECT set_config('app.current_user', ${userId}, true)`;
        return createLeadFieldSchema(transaction, userId, {
          name: "Business software enquiry",
          definition: coordinatorFields,
        });
      });
      const agentVersionId = await publishAgent(
        "Fictional lead coordinator",
        ["lead.write", "lead.finalize", "lead.follow_up"],
        schema.id,
      );

      const from = "12025550301";
      await acceptInbound(`wamid.lead-${randomUUID()}`, "שלום", from);
      const bootstrap = createMessagingStore(
        workerUrl,
        `lead-bootstrap-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: vi.fn(() => Promise.reject(new Error("must not send"))),
          },
        },
      );
      try {
        await processUntilIdle(bootstrap);
      } finally {
        await bootstrap.close();
      }
      const conversationId = await conversationFor(`+${from}`);
      await web.begin(async (transaction) => {
        await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        await transaction`SELECT set_config('app.current_user', ${userId}, true)`;
        await setConversationOwnership(
          transaction,
          conversationId,
          userId,
          "ai",
          agentVersionId,
          "Assigned to the lead coordinator for this test.",
        );
      });

      const requests: WhatsAppAiRequest[] = [];
      const decide = vi
        .fn<(request: WhatsAppAiRequest) => Promise<WhatsAppAiDecision>>()
        .mockImplementation((request) => {
          requests.push(request);
          if (requests.length === 1)
            return Promise.resolve({
              action: "lead_save",
              observations: [
                {
                  key: "preferred_name",
                  state: "known",
                  value: "דנה",
                  confirmed: true,
                },
                {
                  key: "company",
                  state: "known",
                  value: "אבסל",
                  confirmed: true,
                },
              ],
            });
          if (requests.length === 2)
            return Promise.resolve({
              action: "lead_finalize",
              summary:
                "Customer supplied their name and company and requested follow-up.",
            });
          if (requests.length === 3)
            return Promise.resolve({
              action: "lead_follow_up",
              note: "Customer requested a representative to contact them about their enquiry.",
            });
          return Promise.resolve({
            action: "reply",
            text:
              requests.length === 4
                ? "רשמתי את הפרטים לבדיקת הצוות."
                : "תודה רבה.",
          });
        });
      const store = createMessagingStore(
        workerUrl,
        `lead-${randomUUID()}`,
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
        await acceptInbound(
          `wamid.lead-${randomUUID()}`,
          "קוראים לי דנה ואני מאבסל, אשמח שנציג יחזור אליי",
          from,
        );
        expect(await processUntilIdle(store)).toBeGreaterThan(0);
        await acceptInbound(`wamid.lead-thanks-${randomUUID()}`, "תודה", from);
        expect(await processUntilIdle(store)).toBeGreaterThan(0);
      } finally {
        await store.close();
      }

      const jobFailures = await admin<
        { job_type: string; status: string; last_error_safe: string | null }[]
      >`
        SELECT job_type, status, last_error_safe FROM ops.jobs
        WHERE tenant_id=${tenantId}::uuid AND last_error_safe IS NOT NULL
      `;
      expect(jobFailures).toEqual([]);

      // The write really happened, under the pinned schema, attributed to the
      // conversation it came from.
      const leads = await admin<
        {
          id: string;
          reference: string;
          status: string;
          next_action: string | null;
          field_schema_id: string | null;
          field_schema_version: number | null;
          source_conversation_id: string | null;
          agent_profile_version_id: string | null;
        }[]
      >`
        SELECT id, reference, status, next_action, field_schema_id, field_schema_version,
               source_conversation_id, agent_profile_version_id
        FROM crm.leads WHERE tenant_id=${tenantId}::uuid
      `;
      expect(leads).toHaveLength(1);
      expect(leads[0]).toMatchObject({
        status: "ready_for_review",
        next_action:
          "Customer requested a representative to contact them about their enquiry.",
        field_schema_id: schema.id,
        field_schema_version: schema.version,
        source_conversation_id: conversationId,
        agent_profile_version_id: agentVersionId,
      });
      const fields = await admin<
        {
          field_key: string;
          value_state: string;
          raw_value: string | null;
          normalized_value: string | null;
          source_channel: string;
          source_reference_id: string | null;
          recorded_by: string;
        }[]
      >`
        SELECT field_key, value_state, raw_value, normalized_value, source_channel,
               source_reference_id, recorded_by
        FROM crm.lead_field_values
        WHERE lead_id=${leads[0]?.id ?? null}::uuid AND superseded_at IS NULL
        ORDER BY field_key
      `;
      expect(fields.map((field) => field.field_key)).toEqual([
        "company",
        "preferred_name",
      ]);
      // Each value carries where it came from, so a later reviewer can tell an
      // agent's capture from a human's correction — and the provenance is the
      // accepted message the runtime verified, not a string the model chose.
      const trigger = await admin<{ id: string }[]>`
        SELECT id FROM messaging.messages
        WHERE conversation_id=${conversationId}::uuid AND direction='inbound'
          AND content_text=${"קוראים לי דנה ואני מאבסל, אשמח שנציג יחזור אליי"}
      `;
      expect(trigger).toHaveLength(1);
      expect(fields[1]).toMatchObject({
        value_state: "known",
        raw_value: "דנה",
        source_channel: "whatsapp",
        source_reference_id: trigger[0]?.id ?? null,
        recorded_by: "agent",
      });

      // Each next pass sees only actions already committed. The fourth pass
      // produces the reply; its receipts, not model memory, license save claims.
      expect(requests).toHaveLength(5);
      const receipts = requests[1]?.actionReceipts ?? [];
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.action).toBe("lead_save");
      expect(receipts[0]?.ok).toBe(true);
      expect(receipts[0]?.reference).toBe(leads[0]?.reference ?? null);
      expect(receipts[0]?.detail).toContain("preferred_name");
      // The agent has not spent its action budget, so the envelope still
      // offers actions. What makes the claim truthful is the receipt, not a
      // narrowed envelope.
      expect(requests[1]?.replyOnly).toBeUndefined();
      expect(requests[1]?.lead?.collected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "preferred_name", value: "דנה" }),
        ]),
      );
      expect(requests[0]?.lead?.status).toBe("new");
      expect(requests[1]?.lead?.status).toBe("collecting");
      expect(requests[2]?.lead?.status).toBe("ready_for_review");
      expect(requests[3]?.lead?.status).toBe("ready_for_review");
      expect(requests[3]?.replyOnly).toBe(true);
      expect(
        requests[3]?.actionReceipts?.map(({ action, ok }) => ({ action, ok })),
      ).toEqual([
        { action: "lead_save", ok: true },
        { action: "lead_finalize", ok: true },
        { action: "lead_follow_up", ok: true },
      ]);
      // A later customer turn carries durable completion, not stale model
      // memory or the previous turn's receipts. Optional fields remain empty.
      expect(requests[4]?.lead?.status).toBe("ready_for_review");
      expect(requests[4]?.lead?.missingRequired).toEqual([]);
      expect(requests[4]?.actionReceipts).toBeUndefined();
      expect(requests[4]?.contactContext?.identity.channelPhone).toBe(
        `+${from}`,
      );
      const followUps = await admin<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM crm.lead_operations
        WHERE lead_id=${leads[0]?.id ?? null}::uuid
          AND operation='lead.request_follow_up'
      `;
      expect(followUps[0]?.count).toBe(1);
      const delivered = await admin<{ content_text: string }[]>`
        SELECT content_text FROM messaging.messages
        WHERE conversation_id=${conversationId}::uuid AND direction='outbound'
        ORDER BY created_at ASC
      `;
      expect(
        delivered.some(({ content_text }) => content_text.includes("רשמתי")),
      ).toBe(true);
    }, 120_000);

    it("spends a bounded action budget and still answers the customer", async () => {
      const schema = await web.begin(async (transaction) => {
        await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        await transaction`SELECT set_config('app.current_user', ${userId}, true)`;
        return createLeadFieldSchema(transaction, userId, {
          name: "Budgeted enquiry",
          definition: coordinatorFields,
        });
      });
      const agentVersionId = await publishAgent(
        "Fictional budgeted coordinator",
        ["lead.write", "lead.finalize"],
        schema.id,
      );
      const from = "12025550303";
      await acceptInbound(`wamid.budget-${randomUUID()}`, "שלום", from);
      const bootstrap = createMessagingStore(
        workerUrl,
        `budget-bootstrap-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: vi.fn(() => Promise.reject(new Error("must not send"))),
          },
        },
      );
      try {
        await processUntilIdle(bootstrap);
      } finally {
        await bootstrap.close();
      }
      const conversationId = await conversationFor(`+${from}`);
      await web.begin(async (transaction) => {
        await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        await transaction`SELECT set_config('app.current_user', ${userId}, true)`;
        await setConversationOwnership(
          transaction,
          conversationId,
          userId,
          "ai",
          agentVersionId,
          "Assigned to the budgeted coordinator for this test.",
        );
      });

      // Three distinct saves exhaust the turn's budget. The fourth pass must be
      // offered no actions at all, so the turn ends in something readable
      // instead of looping on the provider.
      const values = ["דנה", "דנה כהן", "דנה כהן-לוי"];
      const requests: WhatsAppAiRequest[] = [];
      const decide = vi
        .fn<(request: WhatsAppAiRequest) => Promise<WhatsAppAiDecision>>()
        .mockImplementation((request) => {
          requests.push(request);
          const value = values[requests.length - 1];
          if (value !== undefined)
            return Promise.resolve({
              action: "lead_save",
              observations: [
                {
                  key: "preferred_name",
                  state: "known",
                  value,
                  confirmed: true,
                },
              ],
            });
          return Promise.resolve({ action: "reply", text: "עדכנתי את השם." });
        });
      const store = createMessagingStore(
        workerUrl,
        `budget-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: vi
              .fn<
                (request: WhatsAppSendRequest) => Promise<WhatsAppSendResult>
              >()
              .mockResolvedValue({ messageId: `wamid.${randomUUID()}` }),
          },
        },
        undefined,
        { aiProvider: { decide }, realWhatsAppEnabled: true },
      );
      try {
        await acceptInbound(
          `wamid.budget-${randomUUID()}`,
          "קוראים לי דנה, סליחה — דנה כהן, בעצם דנה כהן-לוי",
          from,
        );
        expect(await processUntilIdle(store)).toBeGreaterThan(0);
      } finally {
        await store.close();
      }

      expect(requests).toHaveLength(4);
      expect(requests.slice(0, 3).map((request) => request.replyOnly)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expect(requests[3]?.replyOnly).toBe(true);
      expect(requests[3]?.actionReceipts).toHaveLength(3);
      // The last correction is what stands, and the earlier ones are kept as
      // history rather than overwritten in place.
      const history = await admin<
        { raw_value: string | null; superseded_at: Date | null }[]
      >`
        SELECT value.raw_value, value.superseded_at
        FROM crm.lead_field_values value
        JOIN crm.leads lead ON lead.id=value.lead_id
        WHERE lead.source_conversation_id=${conversationId}::uuid
          AND value.field_key='preferred_name'
        ORDER BY value.created_at
      `;
      expect(history.map((row) => row.raw_value)).toEqual(values);
      expect(history.map((row) => row.superseded_at === null)).toEqual([
        false,
        false,
        true,
      ]);
      const delivered = await admin<{ content_text: string }[]>`
        SELECT content_text FROM messaging.messages
        WHERE conversation_id=${conversationId}::uuid AND direction='outbound'
        ORDER BY created_at DESC LIMIT 1
      `;
      expect(delivered[0]?.content_text).toBe("עדכנתי את השם.");
    }, 120_000);

    it("refuses a lead write from an agent the operator never gave the capability", async () => {
      const agentVersionId = await publishAgent("Fictional survey agent", []);
      const from = "12025550302";
      await acceptInbound(`wamid.survey-${randomUUID()}`, "שלום", from);
      const bootstrap = createMessagingStore(
        workerUrl,
        `survey-bootstrap-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: vi.fn(() => Promise.reject(new Error("must not send"))),
          },
        },
      );
      try {
        await processUntilIdle(bootstrap);
      } finally {
        await bootstrap.close();
      }
      const conversationId = await conversationFor(`+${from}`);
      await web.begin(async (transaction) => {
        await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        await transaction`SELECT set_config('app.current_user', ${userId}, true)`;
        await setConversationOwnership(
          transaction,
          conversationId,
          userId,
          "ai",
          agentVersionId,
          "Assigned to the survey agent for this test.",
        );
      });
      const before = await admin<{ count: string }[]>`
        SELECT count(*)::text AS count FROM crm.leads
      `;

      // A prompt that talks about saving leads does not grant the permission,
      // and neither does the model emitting the action anyway.
      const decide = vi
        .fn<(request: WhatsAppAiRequest) => Promise<WhatsAppAiDecision>>()
        .mockResolvedValue({
          action: "lead_save",
          observations: [
            { key: "preferred_name", state: "known", value: "דנה" },
          ],
        });
      const store = createMessagingStore(
        workerUrl,
        `survey-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: vi
              .fn<
                (request: WhatsAppSendRequest) => Promise<WhatsAppSendResult>
              >()
              .mockResolvedValue({ messageId: `wamid.${randomUUID()}` }),
          },
        },
        undefined,
        { aiProvider: { decide }, realWhatsAppEnabled: true },
      );
      try {
        await acceptInbound(
          `wamid.survey-${randomUUID()}`,
          "תשמור אותי כליד בבקשה",
          from,
        );
        await processUntilIdle(store);
      } finally {
        await store.close();
      }

      const after = await admin<{ count: string }[]>`
        SELECT count(*)::text AS count FROM crm.leads
      `;
      expect(after[0]?.count).toBe(before[0]?.count);
      const failed = await admin<
        { last_error_safe: string | null; status: string }[]
      >`
        SELECT last_error_safe, status FROM ops.jobs
        WHERE reference_id=${conversationId}::uuid
          AND job_type='whatsapp.ai.reply'
        ORDER BY created_at DESC LIMIT 1
      `;
      expect(failed[0]?.last_error_safe).toBe("lead_action_not_permitted");
      // The refusal is a dead end, not a retry loop burning provider calls.
      expect(failed[0]?.status).toBe("dead");
      expect(decide).toHaveBeenCalledTimes(1);
    }, 120_000);

    it("runs support, lead and survey agents side by side without sharing prompts, tools or effects", async () => {
      const schema = await web.begin(async (transaction) => {
        await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        await transaction`SELECT set_config('app.current_user', ${userId}, true)`;
        return createLeadFieldSchema(transaction, userId, {
          name: "Three agent coordinator",
          definition: coordinatorFields,
        });
      });
      const publishWith = (
        name: string,
        prompt: string,
        capabilities: readonly string[],
        leadFieldSchemaId?: string,
      ) =>
        web.begin(async (transaction) => {
          await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
          await transaction`SELECT set_config('app.current_user', ${userId}, true)`;
          const profileId = await createAgentProfileDraft(transaction, userId, {
            name,
            systemPrompt: prompt,
            locale: "he",
            channels: ["whatsapp"],
            toolPermissions: capabilities,
            ...(leadFieldSchemaId === undefined ? {} : { leadFieldSchemaId }),
          });
          await publishAgentProfile(transaction, userId, profileId);
          const versions = await transaction<{ id: string }[]>`
            SELECT id FROM agents.agent_profile_versions
            WHERE agent_profile_id=${profileId}::uuid AND published_at IS NOT NULL
          `;
          const id = versions[0]?.id;
          if (id === undefined) throw new Error(`${name} was not published`);
          return id;
        });
      const agents = {
        support: {
          from: "12025550311",
          version: await publishWith(
            "Fictional IT support (A)",
            "FIXTURE-A: You are a short Hebrew-speaking IT support agent. Help with the " +
              "customer's technical problem and escalate to a person when you cannot solve it.",
            ["ticket.open"],
          ),
        },
        lead: {
          from: "12025550312",
          version: await publishWith(
            "Fictional lead coordinator (B)",
            "FIXTURE-B: You are the Hebrew-speaking lead coordinator for the configured " +
              "business. Save confirmed information using enabled lead actions and only " +
              "acknowledge successful saves.",
            ["lead.write", "lead.finalize", "lead.follow_up"],
            schema.id,
          ),
        },
        survey: {
          from: "12025550313",
          version: await publishWith(
            "Fictional product survey (C)",
            "FIXTURE-C: Ask two short questions about how the customer uses the product " +
              "and thank them.",
            [],
          ),
        },
      } as const;
      const conversations: Record<keyof typeof agents, string> = {
        support: "",
        lead: "",
        survey: "",
      };
      for (const agent of Object.values(agents))
        await acceptInbound(`wamid.three-${randomUUID()}`, "שלום", agent.from);
      const bootstrap = createMessagingStore(
        workerUrl,
        `three-bootstrap-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: vi.fn(() => Promise.reject(new Error("must not send"))),
          },
        },
      );
      try {
        await processUntilIdle(bootstrap);
      } finally {
        await bootstrap.close();
      }
      for (const purpose of Object.keys(agents) as (keyof typeof agents)[]) {
        conversations[purpose] = await conversationFor(
          `+${agents[purpose].from}`,
        );
        await web.begin(async (transaction) => {
          await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
          await transaction`SELECT set_config('app.current_user', ${userId}, true)`;
          await setConversationOwnership(
            transaction,
            conversations[purpose],
            userId,
            "ai",
            agents[purpose].version,
            `Assigned to the ${purpose} agent for this test.`,
          );
        });
      }

      // Scripted at the provider boundary: every agent is asked for a person,
      // and the lead agent first saves what the customer said.
      const requests: WhatsAppAiRequest[] = [];
      const decide = vi
        .fn<(request: WhatsAppAiRequest) => Promise<WhatsAppAiDecision>>()
        .mockImplementation((request) => {
          requests.push(request);
          if (
            request.systemPrompt.startsWith("FIXTURE-B") &&
            (request.actionReceipts ?? []).length === 0
          )
            return Promise.resolve({
              action: "lead_save",
              observations: [
                {
                  key: "company",
                  state: "known",
                  value: "אבסל",
                  confirmed: true,
                },
              ],
            });
          return Promise.resolve({
            action: "handoff",
            reasonCode: "human_requested",
            text: "מעבירה לנציג.",
          });
        });
      const store = createMessagingStore(
        workerUrl,
        `three-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: vi
              .fn<
                (request: WhatsAppSendRequest) => Promise<WhatsAppSendResult>
              >()
              .mockResolvedValue({ messageId: `wamid.${randomUUID()}` }),
          },
        },
        undefined,
        { aiProvider: { decide }, realWhatsAppEnabled: true },
      );
      try {
        // All three customers write before the worker runs, so their turns are
        // processed in the same passes rather than one conversation at a time.
        for (const agent of Object.values(agents))
          await acceptInbound(
            `wamid.three-${randomUUID()}`,
            "אני רוצה לדבר עם נציג, החברה שלי אבסל",
            agent.from,
          );
        await processUntilIdle(store);
      } finally {
        await store.close();
      }

      // Each request carried its own agent's prompt and nothing else's tools.
      for (const request of requests) {
        const marker = request.systemPrompt.slice(0, 9);
        expect(["FIXTURE-A", "FIXTURE-B", "FIXTURE-C"]).toContain(marker);
        if (marker === "FIXTURE-B")
          expect(request.lead?.schema.fields.length).toBe(4);
        else expect(request.lead).toBeUndefined();
        if (marker === "FIXTURE-C")
          expect(request.capabilities ?? []).toEqual([]);
      }
      const effects = async (conversationId: string) => {
        const [tickets, leads, handoffs] = await Promise.all([
          admin<{ count: string }[]>`
            SELECT count(*)::text AS count FROM support.tickets
            WHERE source_conversation_id=${conversationId}::uuid`,
          admin<{ count: string }[]>`
            SELECT count(*)::text AS count FROM crm.leads
            WHERE source_conversation_id=${conversationId}::uuid`,
          admin<{ count: string }[]>`
            SELECT count(*)::text AS count FROM automation.handoffs
            WHERE conversation_id=${conversationId}::uuid`,
        ]);
        return {
          tickets: Number(tickets[0]?.count),
          leads: Number(leads[0]?.count),
          handoffs: Number(handoffs[0]?.count),
        };
      };
      // Support escalates into a ticket; the lead agent saves a lead and
      // escalates without inventing a support issue; the survey does neither.
      // Every one of them can still reach a person.
      expect(await effects(conversations.support)).toEqual({
        tickets: 1,
        leads: 0,
        handoffs: 1,
      });
      expect(await effects(conversations.lead)).toEqual({
        tickets: 0,
        leads: 1,
        handoffs: 1,
      });
      expect(await effects(conversations.survey)).toEqual({
        tickets: 0,
        leads: 0,
        handoffs: 1,
      });
    }, 180_000);
  },
);
