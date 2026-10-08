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

function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("required synthetic fixture missing");
  return value;
}

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
  phoneRegion: "IL";
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
  "task 8 signed webhook recovery and callback lead routing",
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
          phoneRegion: manifest.phoneRegion,
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

    it.each([
      "valid",
      "invalid_batch",
      "invalid_prefix",
      "worker_retry",
      "volunteered",
    ])(
      "keeps Dana Hebrew and saves one callback after %s",
      async (scenario) => {
        const invalid = scenario === "invalid_batch";
        expect((await web`SELECT current_user AS role`)[0]?.role).toBe(
          "platform_web",
        );
        const schema = await web.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.current_user',${userId},true)`;
          return createLeadFieldSchema(tx, userId, {
            name: "Task 8 discovery",
            completionPolicy: "service_discovery_v1",
            definition: { schemaVersion: "1.0", fields: manifest.fields },
          });
        });
        const agent = await publishAgent(
          `Task 8 published discovery ${scenario}`,
          manifest.capabilities,
          schema.id,
        );
        const from =
          scenario === "volunteered"
            ? "12025550183"
            : scenario === "worker_retry"
              ? "12025550184"
              : scenario === "invalid_prefix"
                ? "12025550185"
                : invalid
                  ? "12025550187"
                  : "12025550186";
        await acceptInbound(`wamid.bootstrap-${randomUUID()}`, "שלום", from);
        const bootstrap = createMessagingStore(
          workerUrl,
          `bootstrap-${randomUUID()}`,
          {
            simulator: new SimulatorWhatsAppProvider(),
            meta: {
              name: "meta",
              send: vi.fn(() => Promise.reject(new Error("no send"))),
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
          await tx`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.current_user',${userId},true)`;
          await setConversationOwnership(
            tx,
            conversationId,
            userId,
            "ai",
            agent,
          );
        });
        let simulatedLoss = false;
        const requests: WhatsAppAiRequest[] = [];
        const decide = vi.fn(
          async (r: WhatsAppAiRequest): Promise<WhatsAppAiDecision> => {
            await Promise.resolve();
            requests.push(r);
            expect(r.locale).toBe("he");
            expect(r.systemPrompt).toContain(manifest.systemPrompt);
            const latestRaw = r.messages
              .filter((x) => x.role === "user")
              .at(-1)?.text;
            const latest = latestRaw?.startsWith("שמי Dana,")
              ? "0501234567"
              : latestRaw;
            const values = Object.fromEntries(
              (r.lead?.collected ?? []).map((x) => [x.key, x.value]),
            );
            if (
              latest === "אפשר מידע על סוכן וואטסאפ לעסק?" &&
              !values.service_interest
            )
              return {
                action: "lead_save",
                observations: [
                  {
                    key: "service_interest",
                    state: "known",
                    value: "סוכן וואטסאפ",
                    confirmed: true,
                  },
                  {
                    key: "need_summary",
                    state: "known",
                    value: "הלקוח מעוניין במענה וואטסאפ עסקי",
                    confirmed: true,
                  },
                ],
              };
            if (latest === "אפשר מידע על סוכן וואטסאפ לעסק?")
              return { action: "reply", text: "איזה סוג של פניות מגיע לעסק?" };
            if (latest === "תחזרו אליי") {
              expect(values.follow_up_allowed).toBe("true");
              return { action: "reply", text: "מה השם שלך?" };
            }
            if (
              (latest === "Dana" || latest === "Dana 050") &&
              !values.contact_name
            )
              return {
                action: "lead_save",
                observations: [
                  {
                    key: "contact_name",
                    state: "known",
                    value: "Dana",
                    confirmed: true,
                  },
                  ...(latest === "Dana 050"
                    ? [
                        {
                          key: "contact_phone",
                          state: "known" as const,
                          value: "050",
                          confirmed: true,
                        },
                      ]
                    : []),
                ],
              };
            if (latest === "050")
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
            if (
              latest === "Dana" &&
              scenario === "worker_retry" &&
              !simulatedLoss
            ) {
              simulatedLoss = true;
              throw new Error("synthetic worker loss after durable name save");
            }
            if (latest === "Dana")
              return { action: "reply", text: "באיזה מספר אפשר לחזור אליך?" };
            if (latest === "0501234567" && !values.contact_phone)
              return {
                action: "lead_save",
                observations: [
                  ...(!values.contact_name
                    ? [
                        {
                          key: "contact_name",
                          state: "known" as const,
                          value: "Dana",
                          confirmed: true,
                          sourceReference: required(
                            required(
                              r.messages.find(
                                (x) =>
                                  x.role === "user" &&
                                  (x.text === "Dana 050" ||
                                    x.text.startsWith("שמי Dana,")),
                              ),
                            ).id,
                          ),
                        },
                      ]
                    : []),
                  {
                    key: "contact_phone",
                    state: "known",
                    value: latest,
                    confirmed: true,
                  },
                  {
                    key: "discussion_complete",
                    state: "known",
                    value: "true",
                    confirmed: true,
                  },
                ],
              };
            if (
              latest === "0501234567" &&
              r.lead?.status !== "ready_for_review"
            )
              return {
                action: "lead_finalize",
                summary: "הלקוח מעוניין בסוכן וואטסאפ וביקש חזרה מנציג",
              };
            if (latest === "0501234567") {
              expect(
                r.actionReceipts?.some(
                  (x) => x.ok && x.action === "lead_finalize",
                ),
              ).toBe(true);
              return { action: "reply", text: manifest.messages.complete };
            }
            return { action: "reply", text: "בשמחה." };
          },
        );
        const send = vi
          .fn<(r: WhatsAppSendRequest) => Promise<WhatsAppSendResult>>()
          .mockImplementation(() =>
            Promise.resolve({
              messageId: `wamid.${randomUUID()}`,
            }),
          );
        const store = createMessagingStore(
          workerUrl,
          `task8-${randomUUID()}`,
          {
            simulator: new SimulatorWhatsAppProvider(),
            meta: { name: "meta", send },
          },
          undefined,
          {
            aiProvider: { decide },
            realWhatsAppEnabled: true,
            automaticCallsEnabled: true,
          },
        );
        try {
          for (const [input, expected] of [
            ["אפשר מידע על סוכן וואטסאפ לעסק?", "איזה סוג של פניות מגיע לעסק?"],
            ...(scenario === "volunteered"
              ? [
                  [
                    "שמי Dana, תחזרו אליי בטלפון 0501234567",
                    manifest.messages.complete,
                  ],
                ]
              : [
                  ["תחזרו אליי", "מה השם שלך?"],
                  [
                    invalid ? "Dana 050" : "Dana",
                    invalid
                      ? "אפשר מספר טלפון תקין לחזרה?"
                      : "באיזה מספר אפשר לחזור אליך?",
                  ],
                  ...(scenario === "invalid_prefix"
                    ? [["050", "אפשר מספר טלפון תקין לחזרה?"]]
                    : []),
                  ["0501234567", manifest.messages.complete],
                ]),
          ]) {
            const id = `wamid.task8-${randomUUID()}`;
            const before = requests.length;
            await acceptInbound(id, required(input), from);
            await processUntilIdle(store);
            if (input === "Dana" && scenario === "worker_retry") {
              const retried =
                await admin`UPDATE ops.jobs SET available_at=clock_timestamp()-interval '1 second' WHERE reference_id=${conversationId}::uuid AND job_type='whatsapp.ai.reply' AND status='retry' RETURNING id`;
              expect(retried).toHaveLength(1);
              await processUntilIdle(store);
            }
            const messages = await admin<
              {
                content_text: string;
                status: string;
                provider_payload: {
                  aiGrounding: { locale: string; localePolicy?: string };
                };
              }[]
            >`SELECT content_text,status,provider_payload FROM messaging.messages WHERE conversation_id=${conversationId}::uuid AND direction='outbound' ORDER BY created_at DESC LIMIT 1`;
            expect(messages[0]?.content_text).toBe(expected);
            expect(messages[0]?.status).toBe("sent");
            expect(messages[0]?.provider_payload.aiGrounding.locale).toBe("he");
            if (input === "Dana 050" || input === "050") {
              expect(requests.length - before).toBe(1); // validation cannot create an unbounded action loop
              const values = await admin<
                { field_key: string }[]
              >`SELECT field_key FROM crm.lead_field_values v JOIN crm.leads l ON l.id=v.lead_id WHERE l.source_conversation_id=${conversationId}::uuid AND v.superseded_at IS NULL`;
              if (input === "Dana 050")
                expect(values.map((x) => x.field_key)).not.toContain(
                  "contact_name",
                ); // atomic batch rejected
              else
                expect(values.map((x) => x.field_key)).toContain(
                  "contact_name",
                );
              expect(values.map((x) => x.field_key)).toContain(
                "service_interest",
              );
            }
            const sent = send.mock.calls.length;
            const calls = decide.mock.calls.length;
            await acceptInbound(id, required(input), from);
            await processUntilIdle(store);
            expect(send).toHaveBeenCalledTimes(sent);
            expect(decide).toHaveBeenCalledTimes(calls);
          }
          expect(await processUntilIdle(store)).toBe(0);
        } finally {
          await store.close();
        }
        const leads = await admin<
          { id: string; status: string }[]
        >`SELECT id,status FROM crm.leads WHERE source_conversation_id=${conversationId}::uuid`;
        expect(leads).toHaveLength(1);
        expect(leads[0]?.status).toBe("ready_for_review");
        const fields = await admin<
          { field_key: string; raw_value: string; normalized_value: string }[]
        >`SELECT field_key,raw_value,normalized_value FROM crm.lead_field_values WHERE lead_id=${required(leads[0]).id}::uuid AND superseded_at IS NULL`;
        expect(
          fields.find((x) => x.field_key === "contact_phone"),
        ).toMatchObject({
          raw_value: "0501234567",
          normalized_value: "+972501234567",
        });
        expect(
          fields.find((x) => x.field_key === "contact_name")?.normalized_value,
        ).toBe("Dana");
        const owned =
          await admin`SELECT ownership_mode FROM messaging.conversations WHERE id=${conversationId}::uuid`;
        expect(owned[0]?.ownership_mode).toBe("ai");
        const identity = await admin<
          { normalized_value: string }[]
        >`SELECT i.normalized_value FROM crm.contact_channel_identities i JOIN messaging.conversations c ON c.contact_id=i.contact_id WHERE c.id=${conversationId}::uuid AND i.channel='whatsapp'`;
        expect(identity.map((x) => x.normalized_value)).toEqual([`+${from}`]);
        const bad =
          await admin`SELECT job_type,status,last_error_safe FROM ops.jobs WHERE tenant_id=${tenantId}::uuid AND (job_type LIKE '%call%' OR status IN ('failed','dead_letter') OR last_error_safe IS NOT NULL)`;
        expect(bad).toEqual([]);
        expect(
          await admin`SELECT id FROM audit.records WHERE target_id=${required(leads[0]).id}::uuid AND action='lead.finalized'`,
        ).toHaveLength(1);
      },
      120_000,
    );

    it.each([
      ["lead", "תחזרו אליי", true, false],
      ["lead", "שנציג יחזור אליי", true, false],
      ["lead", "תתקשרו אליי עכשיו", true, false],
      ["none", "תחזרו אליי", false, true],
      ["read_only", "תחזרו אליי", false, true],
      ["lead", "אני רוצה נציג עכשיו", false, true],
      ["lead", "אל תחזרו אליי", true, false],
      ["lead", 'הוא אמר "תחזרו אליי"', true, false],
      ["lead", "אם תהיה בעיה תחזרו אליי", true, false],
    ] as const)(
      "routes %s / %s without accidental telephony",
      async (mode, input, invokesModel, handsOff) => {
        const id = randomUUID();
        const capabilities =
          mode === "none"
            ? []
            : mode === "read_only"
              ? ["lead.read"]
              : manifest.capabilities;
        const schema =
          mode === "none"
            ? undefined
            : await web.begin(async (tx) => {
                await tx`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.current_user',${userId},true)`;
                return createLeadFieldSchema(tx, userId, {
                  name: `Routing ${id}`,
                  completionPolicy: "service_discovery_v1",
                  definition: { schemaVersion: "1.0", fields: manifest.fields },
                });
              });
        const agent = await publishAgent(
          `Routing ${id}`,
          capabilities,
          schema?.id,
        );
        const from = `1202${String(1000000 + Math.floor(Math.random() * 8999999))}`;
        await acceptInbound(`wamid.init-${id}`, "שלום", from);
        const bootstrap = createMessagingStore(workerUrl, `boot-${id}`, {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: vi.fn(() => Promise.reject(new Error("no send"))),
          },
        });
        try {
          await processUntilIdle(bootstrap);
        } finally {
          await bootstrap.close();
        }
        const conversationId = await conversationFor(`+${from}`);
        await web.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.current_user',${userId},true)`;
          await setConversationOwnership(
            tx,
            conversationId,
            userId,
            "ai",
            agent,
          );
        });
        const decide = vi.fn((): Promise<WhatsAppAiDecision> =>
          Promise.resolve(
            input.startsWith("אל") ||
              input.startsWith("הוא") ||
              input.startsWith("אם")
              ? { action: "reply", text: "באיזה שירות יש עניין?" }
              : {
                  action: "request_call",
                  reasonCode: "call_requested",
                  text: "",
                },
          ),
        );
        const send = vi.fn(() =>
          Promise.resolve({
            messageId: `wamid.${randomUUID()}`,
          }),
        );
        const store = createMessagingStore(
          workerUrl,
          `route-${id}`,
          {
            simulator: new SimulatorWhatsAppProvider(),
            meta: { name: "meta", send },
          },
          undefined,
          {
            aiProvider: { decide },
            realWhatsAppEnabled: true,
            automaticCallsEnabled: true,
          },
        );
        try {
          await acceptInbound(`wamid.route-${id}`, input, from);
          await processUntilIdle(store);
          expect(decide).toHaveBeenCalledTimes(invokesModel ? 1 : 0);
          expect(send).toHaveBeenCalledTimes(1);
          await acceptInbound(`wamid.route-${id}`, input, from);
          await processUntilIdle(store);
          expect(send).toHaveBeenCalledTimes(1);
        } finally {
          await store.close();
        }
        const owner =
          await admin`SELECT ownership_mode FROM messaging.conversations WHERE id=${conversationId}::uuid`;
        expect(owner[0]?.ownership_mode).toBe(handsOff ? "human" : "ai");
        expect(
          await admin`SELECT id FROM ops.jobs WHERE tenant_id=${tenantId}::uuid AND job_type LIKE '%call%'`,
        ).toHaveLength(0);
        const deliveries =
          await admin`SELECT content_text,status FROM messaging.messages WHERE conversation_id=${conversationId}::uuid AND direction='outbound'`;
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]?.status).toBe("sent");
        if (handsOff)
          expect(deliveries[0]?.content_text).toBe(
            "נפתחה בקשה לבדיקת נציג. היא עדיין ממתינה לטיפול.",
          );
      },
      120_000,
    );

    it("rejects missing lead configuration at authoring instead of routing to a paid call", async () => {
      await expect(
        publishAgent("Missing lead schema", ["lead.write"]),
      ).rejects.toThrow("reviewed lead field schema");
      expect(
        await admin`SELECT id FROM agents.agent_profiles WHERE name='Missing lead schema'`,
      ).toHaveLength(0);
    });
  },
);
