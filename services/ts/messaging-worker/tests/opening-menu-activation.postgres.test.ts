import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { seedOpeningMenuFixture } from "./opening-menu-fixture.js";

const url = process.env.OPENING_MENU_TEST_DATABASE_URL;

describe.skipIf(!url)("opening menu first activation boundary", () => {
  it.each([
    "recent",
    "inactive",
    "unprocessed",
    "wrong-account",
    "human",
    "wrong-agent",
    "epoch-change",
    "archived",
    "reopened",
    "foreign-tenant",
    "new-session",
    "continuous-session",
  ])(
    "preserves only a verified continuing conversation: %s",
    async (scenario) => {
      const target = new URL(url ?? "");
      if (
        target.hostname !== "127.0.0.1" ||
        target.port !== "55480" ||
        !/^\/oron_crm_[a-f0-9]{32}$/.test(target.pathname)
      )
        throw new Error("Owned loopback fixture only");
      const sql = postgres(url ?? "", { max: 1, prepare: false });
      try {
        const cfg = await seedOpeningMenuFixture(sql);
        await sql.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant',${cfg.tenant_id},true)`;
          await tx`UPDATE platform.whatsapp_opening_menu_configuration SET enabled=false WHERE tenant_id=${cfg.tenant_id}::uuid`;
          const [channel] = await tx<
            { provider_account_id: string }[]
          >`SELECT provider_account_id FROM messaging.channels WHERE id=${cfg.channel_id}::uuid`;
          const [member] = await tx<
            { user_id: string }[]
          >`SELECT user_id FROM public.memberships WHERE tenant_id=${cfg.tenant_id}::uuid LIMIT 1`;
          if (!channel || !member)
            throw new Error("Fixture binding unavailable");
          const providerAccountId = channel.provider_account_id;
          const contact = randomUUID(),
            conversation = randomUUID();
          await tx`INSERT INTO crm.contacts(id,tenant_id,name,whatsapp_consent) VALUES(${contact}::uuid,${cfg.tenant_id}::uuid,'Fictional activation','granted')`;
          await tx`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,status,ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at)
            VALUES(${conversation}::uuid,${cfg.tenant_id}::uuid,${cfg.channel_id}::uuid,${contact}::uuid,'open',${scenario === "human" ? "human" : "ai"},${cfg.agent_version_id}::uuid,${member.user_id}::uuid,clock_timestamp())`;
          async function inbound(
            at: Date,
            processed = true,
            account = providerAccountId,
          ) {
            const message = randomUUID();
            await tx`INSERT INTO messaging.messages(id,tenant_id,conversation_id,direction,sender_type,content_type,content_text,provider,provider_message_id,status,created_at)
              VALUES(${message}::uuid,${cfg.tenant_id}::uuid,${conversation}::uuid,'inbound','contact','text','Fictional','meta',${message},'received',${at})`;
            await tx`SELECT ops.accept_whatsapp_inbound(${providerAccountId},${message},'whatsapp.message.text',${tx.json({ providerAccountId: account, providerEventId: message, providerMessageId: message, from: "+15555550109", contentType: "text", text: "Fictional", occurredAt: at.toISOString() })})`;
            await tx`UPDATE ops.inbound_events SET provider_account_id=${account},received_at=${at},status=${processed ? "processed" : "received"},processed_at=${processed ? at : null} WHERE provider_event_id=${message} AND tenant_id=${cfg.tenant_id}::uuid`;
          }
          await inbound(
            new Date(
              Date.now() - (scenario === "inactive" ? 25 : 0.5) * 3600000,
            ),
            scenario !== "unprocessed",
            scenario === "wrong-account"
              ? "fictional-other-account"
              : channel.provider_account_id,
          );
          if (scenario === "wrong-agent") {
            const otherVersion = randomUUID();
            await tx`INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,system_prompt,channel_capabilities,validation_status,published_at)
              SELECT ${otherVersion}::uuid,tenant_id,agent_profile_id,2,'Fictional other agent',ARRAY['whatsapp'],'valid',clock_timestamp()
              FROM agents.agent_profile_versions WHERE id=${cfg.agent_version_id}::uuid`;
            await tx`UPDATE platform.whatsapp_opening_menu_configuration SET agent_version_id=${otherVersion}::uuid WHERE tenant_id=${cfg.tenant_id}::uuid`;
          }
          await tx`UPDATE platform.whatsapp_opening_menu_configuration SET enabled=true WHERE tenant_id=${cfg.tenant_id}::uuid`;
          const [stamp] = await tx<
            { activated_at: Date }[]
          >`SELECT activated_at FROM platform.whatsapp_opening_menu_configuration WHERE tenant_id=${cfg.tenant_id}::uuid`;
          if (!stamp) throw new Error("Activation missing");
          // Editing an enabled configuration cannot silently move its boundary.
          await tx`UPDATE platform.whatsapp_opening_menu_configuration SET fallback_language='en' WHERE tenant_id=${cfg.tenant_id}::uuid`;
          const [sameStamp] = await tx<
            { activated_at: Date }[]
          >`SELECT activated_at FROM platform.whatsapp_opening_menu_configuration WHERE tenant_id=${cfg.tenant_id}::uuid`;
          expect(sameStamp?.activated_at.toISOString()).toBe(
            stamp.activated_at.toISOString(),
          );
          if (scenario === "epoch-change") {
            await tx`UPDATE messaging.conversations SET ownership_mode='human' WHERE id=${conversation}::uuid`;
            await tx`UPDATE messaging.conversations SET ownership_mode='ai',ai_enabled_at=clock_timestamp() WHERE id=${conversation}::uuid`;
          }
          if (scenario === "archived")
            await tx`UPDATE messaging.conversations SET removed_from_inbox_at=clock_timestamp() WHERE id=${conversation}::uuid`;
          if (scenario === "reopened")
            await tx`UPDATE messaging.conversations SET inbox_reopened_at=clock_timestamp() WHERE id=${conversation}::uuid`;
          if (scenario === "new-session")
            await inbound(
              new Date(stamp.activated_at.getTime() + 25 * 3600000),
            );
          if (scenario === "continuous-session") {
            await inbound(
              new Date(stamp.activated_at.getTime() + 12 * 3600000),
            );
            await inbound(
              new Date(stamp.activated_at.getTime() + 24 * 3600000),
            );
          }
          if (scenario === "foreign-tenant")
            await tx`SELECT set_config('app.current_tenant',${randomUUID()},true)`;
          const [result] = await tx<
            { allowed: boolean }[]
          >`SELECT platform.opening_menu_legacy_session(${conversation}::uuid) AS allowed`;
          expect(result?.allowed).toBe(
            ["recent", "continuous-session"].includes(scenario),
          );
        });
      } finally {
        await sql.end({ timeout: 1 });
      }
    },
    30000,
  );
});
