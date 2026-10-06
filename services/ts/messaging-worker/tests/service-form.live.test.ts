import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  acceptWhatsAppWebhook,
  readDigitalServiceForm,
  submitDigitalServiceForm,
  queueWhatsAppOutbound,
} from "@or-on/crm";

import { createMessagingStore } from "../src/database.js";
import type { WhatsAppAiProvider } from "../src/ai-provider.js";
import type { FieldServiceAiProvider } from "../src/field-service-provider.js";
import {
  SimulatorWhatsAppProvider,
  type WhatsAppSendRequest,
} from "../src/providers.js";

// Explicit opt-in. Creates/drops only its own UUID-named database; fictional
// data; a recording fake stands in for Meta — nothing leaves the machine.
const sourceUrl = process.env.CROSS_CHANNEL_TEST_DATABASE_URL;
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";

const formPolicy = {
  version: 1,
  requiredIntakeFields: [
    "customerName",
    "customerPhone",
    "storeName",
    "serviceLocation",
    "faultDescription",
  ],
  photoPolicy: "requested",
  selfAssignmentEnabled: true,
  requiredReportFields: ["diagnosis"],
  inquiry: { openOnFirstContact: true },
  whatsappFollowUp: {
    enabled: true,
    trigger: "intake_saved",
    requestPhoto: true,
    consent: "in_call_agreement",
    mode: "form",
  },
};

describe.skipIf(sourceUrl === undefined)(
  "short call WhatsApp form and automatic greeting through the real worker",
  () => {
    const databaseName = `oron_service_form_${randomUUID().replaceAll("-", "")}`;
    const phoneNumberId = String(Date.now());
    const appSecret = "fictional-service-form-secret";
    let maintenance: postgres.Sql;
    let admin: postgres.Sql;
    let workerUrl: string;
    let channelId: string;
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
        ["run", "alembic", "-c", "db/alembic/alembic.ini", "upgrade", "head"],
        { cwd: root, env: environment, stdio: "pipe" },
      );
      execFileSync("uv", ["run", "python", "db/seeds/seed_development.py"], {
        cwd: root,
        env: environment,
        stdio: "pipe",
      });
      admin = postgres(url.toString(), { max: 1 });
      await admin`SELECT set_config('app.current_tenant',${tenantId},false)`;
      cleanup.push(() => admin.end());
      for (const feature of ["contacts", "voice", "whatsapp", "tickets"])
        await admin`
          INSERT INTO platform.tenant_feature_entitlements
            (tenant_id, feature_key, available, enabled, granted_at)
          VALUES (${tenantId}::uuid, ${feature}, true, true, CURRENT_TIMESTAMP)
          ON CONFLICT (tenant_id, feature_key) DO UPDATE SET available=true, enabled=true
        `;
      await admin`
        INSERT INTO platform.tenant_feature_entitlements
          (tenant_id, feature_key, available, enabled, configuration, granted_at)
        VALUES (${tenantId}::uuid, 'field_service', true, true,
                ${admin.json({ workflow: formPolicy })}, CURRENT_TIMESTAMP)
        ON CONFLICT (tenant_id, feature_key) DO UPDATE
          SET available=true, enabled=true, configuration=EXCLUDED.configuration
      `;
      await admin`
        INSERT INTO service.tenant_configuration (tenant_id, enabled, whatsapp_intake_enabled)
        VALUES (${tenantId}::uuid, true, true)
        ON CONFLICT (tenant_id) DO UPDATE SET enabled=true,whatsapp_intake_enabled=true
      `;
      // The tenant's authorised automatic sender for platform replies.
      const profileId = randomUUID();
      await admin`INSERT INTO agents.agent_profiles (id, tenant_id, name) VALUES (${profileId}::uuid, ${tenantId}::uuid, 'Fictional service agent')`;
      await admin`
        INSERT INTO agents.agent_profile_versions
          (tenant_id, agent_profile_id, version, system_prompt, locale,
           channel_capabilities, tool_permissions, validation_status, published_at)
        VALUES (${tenantId}::uuid, ${profileId}::uuid, 1, 'Fictional.', 'he',
                ARRAY['voice','whatsapp']::text[], '["service.intake"]'::jsonb, 'valid', CURRENT_TIMESTAMP)
      `;
      await admin`
        UPDATE crm.tenant_settings SET whatsapp_ai_agent_profile_id=${profileId}::uuid,
          whatsapp_ai_enabled_by_user_id=${userId}::uuid, whatsapp_ai_enabled_at=CURRENT_TIMESTAMP,locale='he'
        WHERE tenant_id=${tenantId}::uuid
      `;
      const channels = await admin<{ id: string }[]>`
        INSERT INTO messaging.channels
          (tenant_id, kind, provider, provider_account_id, display_address, status, configuration)
        VALUES (${tenantId}::uuid, 'whatsapp', 'meta', ${phoneNumberId},
                'Fictional business number', 'active',
                ${admin.json({ phoneNumberId, wabaId: "12345", graphApiVersion: "v26.0" })})
        RETURNING id
      `;
      channelId = channels[0]?.id ?? "";
      await admin`INSERT INTO platform.whatsapp_template_policy(tenant_id,enabled) VALUES(${tenantId}::uuid,true)
        ON CONFLICT (tenant_id) DO UPDATE SET enabled=true`;
      url.searchParams.set("options", "-c role=platform_messaging");
      workerUrl = url.toString();
    }, 180_000);

    afterAll(async () => {
      for (const close of cleanup.reverse()) await close();
    });

    async function acceptInbound(from: string, text: string): Promise<string> {
      const messageId = `wamid.fixture-${randomUUID()}`;
      const rawBody = Buffer.from(
        JSON.stringify({
          entry: [
            {
              id: "12345",
              changes: [
                {
                  value: {
                    metadata: { phone_number_id: phoneNumberId },
                    contacts: [{ profile: { name: "Fictional Customer" } }],
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
      const signature = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
      await acceptWhatsAppWebhook(workerUrl, rawBody, signature, appSecret);
      return messageId;
    }

    async function runWorker(
      guardForms = false,
      overrides: {
        aiProvider?: WhatsAppAiProvider;
        fieldServiceProvider?: FieldServiceAiProvider;
      } = {},
    ): Promise<WhatsAppSendRequest[]> {
      const sent: WhatsAppSendRequest[] = [];
      const store = createMessagingStore(
        workerUrl,
        `service-form-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: vi.fn(async (request: WhatsAppSendRequest) => {
              await request.beforeAttempt?.();
              request.onAttemptStarted?.();
              sent.push(request);
              return { messageId: `wamid.out-${randomUUID()}` };
            }),
          },
        },
        undefined,
        {
          realWhatsAppEnabled: true,
          publicSiteUrl: "https://service.example.invalid",
          ...(guardForms
            ? {
                aiProvider: {
                  decide: () =>
                    Promise.reject(
                      new Error("Pending digital form must not invoke AI"),
                    ),
                },
                fieldServiceProvider: {
                  providerName: "fixture",
                  modelName: "fixture",
                  extractIntake: () =>
                    Promise.reject(
                      new Error("Pending form extraction forbidden"),
                    ),
                  extractProductLabel: () =>
                    Promise.reject(new Error("Unexpected OCR")),
                  summarizeEvidence: () =>
                    Promise.reject(new Error("Unexpected summary")),
                },
              }
            : {}),
          ...overrides,
        },
      );
      try {
        let idle = 0;
        for (let pass = 0; pass < 20 && idle < 2; pass++)
          idle = (await store.processAvailable()) === 0 ? idle + 1 : 0;
      } finally {
        await store.close();
      }
      return sent;
    }

    it("greets a new conversation once, in the customer's language, and leaves it unread", async () => {
      await admin`
        INSERT INTO messaging.whatsapp_auto_greetings
          (tenant_id, channel_id, enabled, template_name, languages, fallback_language, updated_by_user_id)
        VALUES (${tenantId}::uuid, ${channelId}::uuid, true, 'conversation_start',
                ARRAY['en','he'], 'en', ${userId}::uuid)
      `;
      await acceptInbound("972502345681", "שלום, הקופה לא עובדת");
      const first = await runWorker();
      expect(first.map((request) => request.delivery)).toEqual([
        {
          kind: "template",
          templateName: "conversation_start",
          language: "he",
          parameters: [],
        },
      ]);
      expect(first[0]?.recipient).toBe("+972502345681");
      const conversations = await admin<{ unread_count: number }[]>`
        SELECT conversation.unread_count FROM messaging.conversations conversation
        JOIN crm.contact_channel_identities identity
          ON identity.contact_id=conversation.contact_id AND identity.channel='whatsapp'
        WHERE identity.normalized_value='+972502345681'`;
      expect(conversations[0]?.unread_count).toBe(1);
      await acceptInbound("972502345681", "Hello?");
      expect(await runWorker()).toEqual([]);
      await admin`UPDATE messaging.whatsapp_auto_greetings SET enabled=false WHERE channel_id=${channelId}::uuid`;
    });

    it("keeps a first standalone WhatsApp message out of phone-first form intake and cancels queued legacy extraction", async () => {
      const decide = vi.fn<WhatsAppAiProvider["decide"]>().mockResolvedValue({
        action: "reply",
        text: "אפשר לעזור במידע כללי. הטופס להמשך טיפול נפתח לאחר שיחת השירות.",
      });
      const extractIntake = vi
        .fn<FieldServiceAiProvider["extractIntake"]>()
        .mockResolvedValue({
          serviceIntent: true,
          confirmed: false,
          confidence: 1,
          fields: { customerName: "דנה", faultDescription: "המסך לא עובד" },
        });
      const providers = {
        aiProvider: { decide },
        fieldServiceProvider: {
          providerName: "fixture",
          modelName: "fixture",
          extractIntake,
          extractProductLabel: () => Promise.reject(new Error("No OCR")),
          summarizeEvidence: () => Promise.reject(new Error("No summary")),
        },
      };
      const providerId = await acceptInbound(
        "972502345686",
        "שלום, המסך לא עובד",
      );
      await runWorker(false, providers);
      const bindings = await admin<
        { message_id: string; conversation_id: string; contact_id: string }[]
      >`SELECT message.id AS message_id,message.conversation_id,conversation.contact_id
        FROM messaging.messages message JOIN messaging.conversations conversation
        ON conversation.id=message.conversation_id AND conversation.tenant_id=message.tenant_id
        WHERE message.provider_message_id=${providerId}`;
      const binding = bindings[0];
      if (!binding) throw new Error("First inbound not retained");
      expect(extractIntake).not.toHaveBeenCalled();
      expect(decide).toHaveBeenCalledOnce();
      expect(
        await admin`SELECT id FROM service.intake_drafts WHERE conversation_id=${binding.conversation_id}::uuid`,
      ).toEqual([]);
      expect(
        await admin`SELECT id FROM service.cases WHERE conversation_id=${binding.conversation_id}::uuid`,
      ).toEqual([]);
      expect(
        await admin`SELECT id FROM ops.jobs WHERE reference_id=${binding.message_id}::uuid AND job_type='field_service.intake.extract'`,
      ).toEqual([]);
      // A legacy job admitted before switching the current tenant policy is
      // refused before model spending and cannot manufacture an orphan draft.
      const legacyId = randomUUID();
      await admin`INSERT INTO ops.jobs(id,tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key)
        VALUES(${legacyId}::uuid,${tenantId}::uuid,'messaging','field_service.intake.extract','message',${binding.message_id}::uuid,
          ${admin.json({ conversationId: binding.conversation_id, contactId: binding.contact_id, triggerMessageId: binding.message_id })},${`legacy-form-${legacyId}`})`;
      await runWorker(false, providers);
      expect(extractIntake).not.toHaveBeenCalled();
      expect(
        await admin`SELECT status,last_error_safe FROM ops.jobs WHERE id=${legacyId}::uuid`,
      ).toEqual([
        { status: "cancelled", last_error_safe: "digital_form_phone_first" },
      ]);
      await acceptInbound("972502345686", "תודה, אפשר מידע כללי?");
      await runWorker(false, providers);
      expect(decide).toHaveBeenCalledTimes(2);
      expect(
        await admin`SELECT id FROM service.intake_drafts WHERE conversation_id=${binding.conversation_id}::uuid`,
      ).toEqual([]);
      const summaryPolicy = {
        ...formPolicy,
        whatsappFollowUp: { ...formPolicy.whatsappFollowUp, mode: "summary" },
      };
      const setPolicy = async (policy: typeof formPolicy) => {
        await admin`UPDATE platform.tenant_feature_entitlements SET configuration=${admin.json({ workflow: policy })}
          WHERE tenant_id=${tenantId}::uuid AND feature_key='field_service'`;
      };
      try {
        await setPolicy(summaryPolicy);
        const ordinaryId = await acceptInbound("972502345687", "המסך לא עובד");
        await runWorker(false, providers);
        expect(extractIntake).toHaveBeenCalledOnce();
        expect(
          await admin`SELECT intake.id FROM service.intake_drafts intake JOIN messaging.messages message
          ON message.conversation_id=intake.conversation_id AND message.tenant_id=intake.tenant_id
          WHERE message.provider_message_id=${ordinaryId}`,
        ).toHaveLength(1);
        // Current policy is rechecked after the external model returns. The
        // previously loaded ordinary policy cannot create a new form draft.
        extractIntake.mockImplementationOnce(async () => {
          await setPolicy(formPolicy);
          return {
            serviceIntent: true,
            confirmed: false,
            confidence: 1,
            fields: { customerName: "דנה", faultDescription: "המסך לא עובד" },
          };
        });
        const racingId = await acceptInbound("972502345688", "המסך לא עובד");
        await runWorker(false, providers);
        expect(extractIntake).toHaveBeenCalledTimes(2);
        expect(
          await admin`SELECT intake.id FROM service.intake_drafts intake JOIN messaging.messages message
          ON message.conversation_id=intake.conversation_id AND message.tenant_id=intake.tenant_id
          WHERE message.provider_message_id=${racingId}`,
        ).toEqual([]);
        expect(
          await admin`SELECT job.status,job.last_error_safe FROM ops.jobs job JOIN messaging.messages message
          ON message.id=job.reference_id AND message.tenant_id=job.tenant_id
          WHERE message.provider_message_id=${racingId} AND job.job_type='field_service.intake.extract'`,
        ).toEqual([
          { status: "cancelled", last_error_safe: "digital_form_phone_first" },
        ]);
      } finally {
        await setPolicy(formPolicy);
      }
    });

    it.each(["admitted", "blocked_window", "queued", "blocked_existing"])(
      "keeps a %s digital form pending when the customer replies in plain WhatsApp",
      async (followupStatus) => {
        const caller =
          followupStatus === "admitted"
            ? "+972502345682"
            : followupStatus === "blocked_window"
              ? "+972502345683"
              : followupStatus === "queued"
                ? "+972502345684"
                : "+972502345685";
        const contactId = randomUUID();
        const sessionId = randomUUID();
        await admin`INSERT INTO crm.contacts (id, tenant_id, name, whatsapp_consent) VALUES (${contactId}::uuid, ${tenantId}::uuid, ${caller}, 'granted')`;
        await admin`
        INSERT INTO crm.contact_channel_identities
          (tenant_id, contact_id, channel, normalized_value, validation_status, is_primary)
        VALUES (${tenantId}::uuid, ${contactId}::uuid, 'phone', ${caller}, 'valid', true),
               (${tenantId}::uuid, ${contactId}::uuid, 'whatsapp', ${caller}, 'valid', false)
      `;
        const conversations = await admin<{ id: string }[]>`
        INSERT INTO messaging.conversations (tenant_id, channel_id, contact_id, status)
        VALUES (${tenantId}::uuid, ${channelId}::uuid, ${contactId}::uuid, 'open') RETURNING id
      `;
        const conversationId = conversations[0]?.id ?? "";
        await admin`
        INSERT INTO sessions (session_id, provider, direction, room, status, tenant_id, flow_id, contact_id, ended_at)
        VALUES (${sessionId}::uuid, 'livekit', 'inbound', ${`room-${sessionId}`}, 'ended',
                ${tenantId}::uuid, ${randomUUID()}::uuid, ${contactId}::uuid, now())
      `;
        await admin`INSERT INTO public.session_events(tenant_id,session_id,sequence,event_type,payload)
        SELECT ${tenantId}::uuid,${sessionId}::uuid,0,'voice.agent.binding.v1',
          jsonb_build_object('caller_identity_id',id) FROM crm.contact_channel_identities
        WHERE tenant_id=${tenantId}::uuid AND contact_id=${contactId}::uuid AND channel='phone'`;
        const intakes = await admin<{ id: string }[]>`
        INSERT INTO service.intake_drafts
          (tenant_id, conversation_id, reporting_contact_id, customer_contact_id,
           customer_resolution_status, correlation_key, collected_fields,
           source_session_id, followup_status)
        VALUES (${tenantId}::uuid, ${conversationId}::uuid, ${contactId}::uuid, ${contactId}::uuid,
                'reporting_contact', ${`voice:${sessionId}`},
                ${admin.json({ customerName: "דנה", customerPhone: caller, faultDescription: "מסך קופה לא עובד" })},
                ${sessionId}::uuid, ${followupStatus.startsWith("blocked") ? "blocked_window" : followupStatus})
        RETURNING id
      `;
        const intakeId = intakes[0]?.id ?? "";
        expect(
          await admin`SELECT id FROM messaging.channels WHERE tenant_id=${tenantId}::uuid AND kind='whatsapp' AND provider='meta' AND status='active'`,
        ).toHaveLength(1);
        if (followupStatus === "blocked_existing")
          await admin`INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,status,completed_at)
          VALUES(${tenantId}::uuid,'messaging','field_service.intake_followup','intake_draft',${intakeId}::uuid,'{}'::jsonb,${`service-followup:${intakeId}`},'succeeded',now())`;
        if (followupStatus === "blocked_existing") {
          const alternate = "+972502345689";
          await admin`INSERT INTO crm.contact_channel_identities(tenant_id,contact_id,channel,normalized_value,validation_status,is_primary)
            VALUES(${tenantId}::uuid,${contactId}::uuid,'whatsapp',${alternate},'valid',false)`;
          await acceptInbound(
            alternate.slice(1),
            "שם החנות: אין הרשאה לקבל קישור למתקשר אחר",
          );
          expect(await runWorker(true)).toEqual([]);
          expect(
            await admin`SELECT followup_status FROM service.intake_drafts WHERE id=${intakeId}::uuid`,
          ).toEqual([{ followup_status: "blocked_window" }]);
        }
        const jobsToGuard = [
          "whatsapp.ai.reply",
          "field_service.intake.extract",
          "support.postcall.reply",
        ];
        for (const jobType of jobsToGuard)
          await admin`INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key)
          VALUES(${tenantId}::uuid,'messaging',${jobType},'conversation',${conversationId}::uuid,
            ${admin.json({ conversationId, contactId, triggerMessageId: randomUUID(), messageId: randomUUID() })},${`pending-form-${randomUUID()}`})`;
        await acceptInbound(
          caller.slice(1),
          "מיקום התקלה: קופה 3 ליד הכניסה\nשם החנות: סופר דיזנגוף\nשם איש קשר: יוסי\nהמסך לא נדלק",
        );
        if (followupStatus.startsWith("blocked"))
          await acceptInbound(caller.slice(1), "אפשר קישור לטופס?");
        const sent = await runWorker(true);
        const cases = await admin<
          { reference: string; title: string; fault_description: string }[]
        >`SELECT reference, title, fault_description FROM service.cases WHERE intake_draft_id=${intakeId}::uuid`;
        expect(cases).toEqual([]);
        if (!followupStatus.startsWith("blocked")) expect(sent).toEqual([]);
        const draft = await admin<
          { status: string; collected_fields: unknown }[]
        >`
        SELECT status,collected_fields FROM service.intake_drafts WHERE id=${intakeId}::uuid`;
        expect(draft[0]?.status).toBe("collecting");
        expect(draft[0]?.collected_fields).toEqual({
          customerName: "דנה",
          customerPhone: caller,
          faultDescription: "מסך קופה לא עובד",
        });
        // Previously queued automatic work is cancelled, not silently executed.
        const jobs = await admin<
          { job_type: string; status: string; last_error_safe: string }[]
        >`
        SELECT job_type,status,last_error_safe FROM ops.jobs
        WHERE tenant_id=${tenantId}::uuid AND reference_id=${conversationId}::uuid
          AND job_type IN ('whatsapp.ai.reply','field_service.intake.extract','support.postcall.reply')`;
        expect(jobs).toHaveLength(3);
        expect(
          jobs.every(
            (job) =>
              job.status === "cancelled" &&
              job.last_error_safe === "digital_form_pending",
          ),
        ).toBe(true);
        if (followupStatus !== "admitted") {
          const eligibility = await admin<
            { id: string; open: boolean }[]
          >`SELECT id,customer_service_window_expires_at>now() AS open FROM messaging.conversations WHERE id=${conversationId}::uuid`;
          expect(eligibility).toEqual([{ id: conversationId, open: true }]);
          let delivered = sent;
          if (followupStatus === "queued") {
            // Form mode cannot fall back to a template outside the service window.
            await admin`UPDATE messaging.conversations SET customer_service_window_expires_at=now()-interval '1 hour' WHERE id=${conversationId}::uuid`;
            await admin`INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key)
            VALUES(${tenantId}::uuid,'messaging','field_service.intake_followup','intake_draft',${intakeId}::uuid,'{}'::jsonb,${`service-followup:${intakeId}`})`;
            expect(await runWorker(true)).toEqual([]);
            expect(
              await admin`SELECT 1 FROM service.digital_intake_forms WHERE intake_id=${intakeId}::uuid`,
            ).toHaveLength(0);
            expect(
              await admin`SELECT followup_status FROM service.intake_drafts WHERE id=${intakeId}::uuid`,
            ).toEqual([{ followup_status: "blocked_window" }]);
            await acceptInbound(
              caller.slice(1),
              "Please send the form in English",
            );
            delivered = await runWorker(true);
          }
          const admission =
            await admin`SELECT followup_status,followup_error_safe FROM service.intake_drafts WHERE id=${intakeId}::uuid`;
          expect({ delivered: delivered.length, admission }).toEqual({
            delivered: 1,
            admission: [
              { followup_status: "admitted", followup_error_safe: null },
            ],
          });
          const delivery = delivered[0]?.delivery;
          if (delivery?.kind !== "text")
            throw new Error("Form must be a text link");
          expect(delivery.text).toContain(
            "https://service.example.invalid/service-request#tenant=",
          );
          expect(delivery.text).toContain(
            followupStatus === "queued" ? "press Submit" : "ללחוץ על שליחה",
          );
          expect(delivery.text).not.toContain("השיבו להודעה");
          const url = new URL(delivery.text.split("\n").at(-1) ?? "");
          const fragment = new URLSearchParams(url.hash.slice(1));
          expect(fragment.get("tenant")).toBe(tenantId);
          expect(fragment.get("token")).toMatch(/^[0-9a-f]{64}$/u);
          const forms = await admin<
            { token_hash: string }[]
          >`SELECT token_hash FROM service.digital_intake_forms WHERE intake_id=${intakeId}::uuid`;
          expect(forms).toHaveLength(1);
          expect(forms[0]?.token_hash).not.toBe(fragment.get("token"));
          await acceptInbound(caller.slice(1), "שם החנות: מקום אחר");
          expect(await runWorker(true)).toEqual([]);
          expect(
            await admin`SELECT 1 FROM service.cases WHERE intake_draft_id=${intakeId}::uuid`,
          ).toHaveLength(0);
        }
      },
    );

    it("delivers only the reviewed form template to a first-time caller with general templates disabled", async () => {
      // Match the published phone-first policy: location comes from the digital
      // form; no separate store-name field is requested from this customer.
      await admin`UPDATE platform.tenant_feature_entitlements SET configuration=${admin.json(
        {
          workflow: {
            ...formPolicy,
            requiredIntakeFields: [
              "customerName",
              "customerPhone",
              "serviceLocation",
              "faultDescription",
            ],
            inquiry: { openOnFirstContact: false },
          },
        },
      )} WHERE tenant_id=${tenantId}::uuid AND feature_key='field_service'`;
      const caller = "+972502345690";
      const contactId = randomUUID();
      const sessionId = randomUUID();
      await admin`UPDATE platform.whatsapp_template_policy SET enabled=false WHERE tenant_id=${tenantId}::uuid`;
      await admin`INSERT INTO service.whatsapp_form_template_policy
        (tenant_id,channel_id,template_name,template_language,provider_template_id,public_origin,enabled)
        VALUES(${tenantId}::uuid,${channelId}::uuid,'service_form_link','he','123456','https://service.example.invalid',true)`;
      await admin`INSERT INTO crm.contacts(id,tenant_id,name,whatsapp_consent)
        VALUES(${contactId}::uuid,${tenantId}::uuid,'Fixture caller','granted')`;
      await admin`INSERT INTO crm.contact_channel_identities
        (tenant_id,contact_id,channel,normalized_value,validation_status,is_primary)
        VALUES(${tenantId}::uuid,${contactId}::uuid,'phone',${caller},'valid',true)`;
      await admin`INSERT INTO sessions(session_id,provider,direction,room,status,tenant_id,flow_id,contact_id)
        VALUES(${sessionId}::uuid,'livekit','inbound',${`room-${sessionId}`},'started',${tenantId}::uuid,${randomUUID()}::uuid,${contactId}::uuid)`;
      await admin`INSERT INTO public.session_events(tenant_id,session_id,sequence,event_type,payload)
        SELECT ${tenantId}::uuid,${sessionId}::uuid,0,'voice.agent.binding.v1',jsonb_build_object('caller_identity_id',id,
          'agent_version_id',(SELECT id FROM agents.agent_profile_versions WHERE tenant_id=${tenantId}::uuid AND tool_permissions ? 'service.intake' AND published_at IS NOT NULL ORDER BY created_at DESC LIMIT 1))
        FROM crm.contact_channel_identities WHERE tenant_id=${tenantId}::uuid AND contact_id=${contactId}::uuid AND channel='phone'`;
      const captured = await admin.begin(async (tx) => {
        await tx`SET LOCAL ROLE platform_voice`;
        return tx<
          { receipt: { intakeId: string } }[]
        >`SELECT service.capture_service_intake(${sessionId}::uuid,
          ${tx.json({ customerName: "דנה", faultDescription: "המסך לא נדלק" })},false) AS receipt`;
      });
      const intakeId = captured[0]?.receipt.intakeId;
      if (intakeId === undefined)
        throw new Error("Voice intake was not captured");
      await admin`UPDATE service.whatsapp_form_template_policy SET enabled=false WHERE tenant_id=${tenantId}::uuid`;
      const blocked = await admin.begin(async (tx) => {
        await tx`SET LOCAL ROLE platform_voice`;
        return tx`SELECT service.request_intake_followup(${sessionId}::uuid,true) AS receipt`;
      });
      expect(blocked[0]?.receipt).toMatchObject({
        status: "unavailable",
        reason: "whatsapp_template_required",
      });
      await admin`UPDATE service.whatsapp_form_template_policy SET enabled=true WHERE tenant_id=${tenantId}::uuid`;
      const admission = await admin.begin(async (tx) => {
        await tx`SET LOCAL ROLE platform_voice`;
        return tx`SELECT service.request_intake_followup(${sessionId}::uuid,true) AS receipt`;
      });
      expect(admission[0]?.receipt).toMatchObject({
        status: "queued",
        intakeId,
      });
      const sent = await runWorker(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.recipient).toBe(caller);
      const delivery = sent[0]?.delivery;
      if (delivery?.kind !== "template")
        throw new Error("Expected reviewed form template");
      expect(delivery.templateName).toBe("service_form_link");
      expect(delivery.language).toBe("he");
      expect(delivery.parameters).toHaveLength(1);
      const url = new URL(delivery.parameters[0] ?? "");
      const fragment = new URLSearchParams(url.hash.slice(1));
      const token = fragment.get("token") ?? "";
      expect(fragment.get("tenant")).toBe(tenantId);
      expect(
        await admin`SELECT platform.whatsapp_templates_enabled() AS enabled`,
      ).toEqual([{ enabled: false }]);
      expect(
        await admin`SELECT id FROM service.cases WHERE intake_draft_id=${intakeId}::uuid`,
      ).toHaveLength(0);
      expect(await runWorker(true)).toEqual([]);
      const requests = await admin<{ id: string; conversation_id: string }[]>`
        SELECT id,conversation_id FROM messaging.outbound_requests WHERE idempotency_key=${`service-followup:${intakeId}`}`;
      const request = requests[0];
      if (request === undefined)
        throw new Error("Follow-up request was not queued");
      expect(
        await admin`SELECT platform.whatsapp_template_request_allowed(r) AS allowed FROM messaging.outbound_requests r WHERE id=${request.id}::uuid`,
      ).toEqual([{ allowed: true }]);
      // General template access remains closed, including a manual send of the
      // same template. Neither an arbitrary body nor a different caller is licensed.
      await expect(
        admin.begin(async (tx) => {
          await tx`SET LOCAL ROLE platform_web`;
          await queueWhatsAppOutbound(
            tx,
            {
              conversationId: request.conversation_id,
              explicitlyConfirmed: true,
              idempotencyKey: `manual-${randomUUID()}`,
              kind: "template",
              language: "he",
              parameters: delivery.parameters,
              provider: "meta",
              realProviderEnabled: true,
              senderUserId: userId,
              templateName: "service_form_link",
            },
            { phoneNumberId, wabaId: "12345", graphApiVersion: "v26.0" },
          );
        }),
      ).rejects.toThrow("templates are unavailable");
      for (const parameters of [
        ["https://evil.example.invalid/service-request#token=" + token],
        [url.toString().replace(token, "b".repeat(64))],
      ]) {
        await expect(
          admin`UPDATE messaging.outbound_requests SET template_parameters=${admin.json(parameters)} WHERE id=${request.id}::uuid`,
        ).rejects.toThrow("not authorized");
      }
      await expect(
        admin`UPDATE messaging.outbound_requests SET template_name='other_template' WHERE id=${request.id}::uuid`,
      ).rejects.toThrow("not authorized");
      await expect(
        admin`UPDATE messaging.outbound_requests SET recipient_address='+972502345699' WHERE id=${request.id}::uuid`,
      ).rejects.toThrow("outbound recipient binding is immutable");
      await admin`UPDATE service.whatsapp_form_template_policy SET enabled=false WHERE tenant_id=${tenantId}::uuid`;
      expect(
        await admin`SELECT platform.whatsapp_template_request_allowed(r) AS allowed FROM messaging.outbound_requests r WHERE id=${request.id}::uuid`,
      ).toEqual([{ allowed: false }]);
      await admin`UPDATE service.whatsapp_form_template_policy SET enabled=true WHERE tenant_id=${tenantId}::uuid`;
      const form = await admin.begin(async (tx) => {
        await tx`SET LOCAL ROLE platform_web`;
        return readDigitalServiceForm(tx, token);
      });
      expect(form?.customerName).toBe("דנה");
      expect(form?.faultDescription).toBe("המסך לא נדלק");
      const submission = {
        customerName: "דנה",
        serviceLocation: "אתר בדיקה",
        faultDescription: "תיאור חופשי מהטופס",
        confirmed: true,
        photos: [],
      };
      const receipt = await admin.begin(async (tx) => {
        await tx`SET LOCAL ROLE platform_web`;
        return submitDigitalServiceForm(tx, token, submission);
      });
      expect(receipt.created).toBe(true);
      expect(
        await admin.begin((tx) =>
          submitDigitalServiceForm(tx, token, submission),
        ),
      ).toEqual({ ...receipt, created: false });
      expect(
        await admin`SELECT id FROM service.cases WHERE intake_draft_id=${intakeId}::uuid`,
      ).toHaveLength(1);
      expect(
        await admin`SELECT id FROM support.tickets WHERE tenant_id=${tenantId}::uuid AND service_case_id IN
          (SELECT id FROM service.cases WHERE tenant_id=${tenantId}::uuid AND intake_draft_id=${intakeId}::uuid)`,
      ).toHaveLength(1);
      expect(
        await admin`SELECT platform.whatsapp_template_request_allowed(r) AS allowed FROM messaging.outbound_requests r WHERE id=${request.id}::uuid`,
      ).toEqual([{ allowed: false }]);
      // A real least-privileged worker must also finish the dossier summary.
      // In production this used to fail by joining the inaccessible tenants table.
      const summarizeEvidence = vi.fn(() => Promise.resolve("סיכום בדיקה"));
      await runWorker(true, {
        fieldServiceProvider: {
          providerName: "fixture",
          modelName: "fixture",
          extractIntake: () =>
            Promise.reject(new Error("No extraction after submission")),
          extractProductLabel: () =>
            Promise.reject(new Error("No OCR requested")),
          summarizeEvidence,
        },
      });
      expect(
        await admin`SELECT status,error_safe FROM service.case_summaries WHERE case_id IN
        (SELECT id FROM service.cases WHERE intake_draft_id=${intakeId}::uuid) AND source_kind='whatsapp'`,
      ).toEqual([{ status: "completed", error_safe: null }]);
      expect(summarizeEvidence).toHaveBeenCalled();
      expect(summarizeEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          locale: "he",
          sourceKind: "whatsapp",
        }),
      );
    });
  },
);
