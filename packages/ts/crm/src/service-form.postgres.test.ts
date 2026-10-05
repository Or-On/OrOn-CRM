import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { ingestWhatsAppInbound } from "./messaging.js";
import {
  planWhatsAppAutoGreeting,
  saveWhatsAppAutoGreeting,
} from "./whatsapp-auto-greeting.js";
import { queueWhatsAppOutbound } from "./whatsapp-outbound.js";

const databaseUrl = process.env.CRM_TEST_DATABASE_URL;

class ExpectedRollback extends Error {}

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
    formFields: ["serviceLocation", "storeName", "customerName"],
  },
};

interface Fixture {
  readonly tenant: string;
  readonly owner: string;
  readonly contact: string;
  readonly channel: string;
  readonly account: string;
  readonly conversation: string;
}

/** A fictional tenant whose caller already got the WhatsApp form after a call. */
async function fixture(
  sql: postgres.TransactionSql,
  templates = true,
): Promise<Fixture> {
  const tenant = randomUUID();
  const owner = randomUUID();
  const contact = randomUUID();
  const account = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await sql`INSERT INTO tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Fictional field service',${`form-fixture-${tenant}`},'active')`;
  if (templates)
    await sql`INSERT INTO platform.whatsapp_template_policy(tenant_id,enabled) VALUES(${tenant}::uuid,true)`;
  await sql`INSERT INTO users(id,email,display_name,status) VALUES(${owner}::uuid,${`${owner}@example.invalid`},'Fictional owner','active')`;
  await sql`INSERT INTO memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${owner}::uuid,'owner')`;
  await sql`INSERT INTO crm.tenant_settings(tenant_id,locale) VALUES(${tenant}::uuid,'he')`;
  for (const feature of ["field_service", "tickets", "whatsapp", "contacts"])
    await sql`INSERT INTO platform.tenant_feature_entitlements(tenant_id,feature_key,available,enabled,granted_at,source)
      VALUES(${tenant}::uuid,${feature},true,true,CURRENT_TIMESTAMP,'provisioning')
      ON CONFLICT (tenant_id,feature_key) DO UPDATE SET available=true,enabled=true`;
  await sql`UPDATE platform.tenant_feature_entitlements SET configuration=${sql.json({ workflow: formPolicy })}
    WHERE tenant_id=${tenant}::uuid AND feature_key='field_service'`;
  // The WhatsApp-initiated intake switch stays off: the phone form must not need it.
  await sql`INSERT INTO service.tenant_configuration(tenant_id,enabled,whatsapp_intake_enabled) VALUES(${tenant}::uuid,true,false)`;
  await sql`INSERT INTO crm.contacts(id,tenant_id,name,whatsapp_consent) VALUES(${contact}::uuid,${tenant}::uuid,'+972502345671','granted')`;
  // The caller's number and its WhatsApp twin, as the phone follow-up leaves them.
  await sql`INSERT INTO crm.contact_channel_identities(tenant_id,contact_id,channel,normalized_value,validation_status,is_primary)
    VALUES(${tenant}::uuid,${contact}::uuid,'phone','+972502345671','valid',true),
      (${tenant}::uuid,${contact}::uuid,'whatsapp','+972502345671','valid',false)`;
  const channels = await sql<{ id: string }[]>`
    INSERT INTO messaging.channels(tenant_id,kind,provider,provider_account_id,status,configuration)
    VALUES(${tenant}::uuid,'whatsapp','meta',${account},'active',
      ${sql.json({ phoneNumberId: account, wabaId: "12345", graphApiVersion: "v23.0" })})
    RETURNING id`;
  const channel = channels[0]?.id ?? "";
  const conversations = await sql<{ id: string }[]>`
    INSERT INTO messaging.conversations(tenant_id,channel_id,contact_id,status)
    VALUES(${tenant}::uuid,${channel}::uuid,${contact}::uuid,'open') RETURNING id`;
  return {
    tenant,
    owner,
    contact,
    channel,
    account,
    conversation: conversations[0]?.id ?? "",
  };
}

async function asWorker(sql: postgres.TransactionSql, tenant: string) {
  await sql`RESET ROLE`;
  await sql`SET LOCAL ROLE platform_messaging`;
  await sql`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user','',true),set_config('app.current_role','service',true)`;
}

function inbound(fixtureValue: Fixture, text: string) {
  const id = randomUUID();
  return {
    providerAccountId: fixtureValue.account,
    providerEventId: `event-${id}`,
    providerMessageId: `wamid.${id}`,
    from: "+972502345671",
    profileName: "דנה",
    contentType: "text" as const,
    text,
    occurredAt: new Date().toISOString(),
  };
}

describe.skipIf(databaseUrl === undefined)(
  "tenant-scoped WhatsApp automatic greeting against PostgreSQL",
  () => {
    it("greets only a new conversation, in the customer's language, and keeps it unread", async () => {
      if (databaseUrl === undefined) throw new Error("fixture URL required");
      const database = postgres(databaseUrl, { max: 1, prepare: false });
      try {
        await expect(
          database.begin(async (sql) => {
            const value = await fixture(sql);
            await sql`SET LOCAL ROLE platform_web`;
            await sql`SELECT set_config('app.current_tenant',${value.tenant},true),set_config('app.current_user',${value.owner},true),set_config('app.current_role','owner',true)`;
            await saveWhatsAppAutoGreeting(sql, value.owner, value.channel, {
              enabled: true,
              templateName: "conversation_start",
              languages: ["en", "he"],
              fallbackLanguage: "he",
            });
            await asWorker(sql, value.tenant);
            const first = await ingestWhatsAppInbound(
              sql,
              inbound(value, "Hi, my register is broken"),
            );
            const plan = await planWhatsAppAutoGreeting(
              sql,
              first.messageId ?? "",
            );
            expect(plan).toMatchObject({
              conversationId: value.conversation,
              templateName: "conversation_start",
              language: "en",
              actorUserId: value.owner,
              provider: "meta",
              channelConfiguration: {
                phoneNumberId: value.account,
                wabaId: "12345",
                graphApiVersion: "v23.0",
              },
            });
            if (plan?.channelConfiguration === undefined)
              throw new Error("plan missing");
            await sql`SELECT set_config('app.current_user',${plan.actorUserId},true)`;
            const queued = await queueWhatsAppOutbound(
              sql,
              {
                conversationId: plan.conversationId,
                explicitlyConfirmed: true,
                idempotencyKey: `auto-greeting:${first.messageId ?? ""}`,
                kind: "template",
                templateName: plan.templateName,
                language: plan.language,
                parameters: [],
                provider: "meta",
                realProviderEnabled: true,
                senderUserId: plan.actorUserId,
                senderType: "system",
                acknowledgesInbound: false,
              },
              plan.channelConfiguration,
            );
            expect(queued.queued).toBe(true);
            const unread = await sql<{ unread_count: number }[]>`
              SELECT unread_count FROM messaging.conversations WHERE id=${value.conversation}::uuid`;
            expect(unread[0]?.unread_count).toBe(1);
            // Within the same day the thread is ongoing: no second greeting.
            await sql`SELECT set_config('app.current_user','',true)`;
            const second = await ingestWhatsAppInbound(
              sql,
              inbound(value, "שלום?"),
            );
            expect(
              await planWhatsAppAutoGreeting(sql, second.messageId ?? ""),
            ).toBeUndefined();
            throw new ExpectedRollback();
          }),
        ).rejects.toThrow(ExpectedRollback);
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("chooses Hebrew for a Hebrew first message and stays silent when disabled", async () => {
      if (databaseUrl === undefined) throw new Error("fixture URL required");
      const database = postgres(databaseUrl, { max: 1, prepare: false });
      try {
        await expect(
          database.begin(async (sql) => {
            const value = await fixture(sql);
            await sql`SET LOCAL ROLE platform_web`;
            await sql`SELECT set_config('app.current_tenant',${value.tenant},true),set_config('app.current_user',${value.owner},true),set_config('app.current_role','owner',true)`;
            await saveWhatsAppAutoGreeting(sql, value.owner, value.channel, {
              enabled: true,
              templateName: "conversation_start",
              languages: ["en", "he"],
              fallbackLanguage: "en",
            });
            await asWorker(sql, value.tenant);
            const hebrew = await ingestWhatsAppInbound(
              sql,
              inbound(value, "שלום, הקופה לא עובדת"),
            );
            expect(
              (await planWhatsAppAutoGreeting(sql, hebrew.messageId ?? ""))
                ?.language,
            ).toBe("he");
            await sql`RESET ROLE`;
            await sql`UPDATE messaging.whatsapp_auto_greetings SET enabled=false WHERE tenant_id=${value.tenant}::uuid`;
            await asWorker(sql, value.tenant);
            expect(
              await planWhatsAppAutoGreeting(sql, hebrew.messageId ?? ""),
            ).toBeUndefined();
            throw new ExpectedRollback();
          }),
        ).rejects.toThrow(ExpectedRollback);
      } finally {
        await database.end({ timeout: 2 });
      }
    });
  },
);
