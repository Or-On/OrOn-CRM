import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createAgentProfileDraft } from "@or-on/crm";
import { createMessagingStore } from "../src/database.js";
import {
  SimulatorWhatsAppProvider,
  type WhatsAppSendRequest,
} from "../src/providers.js";
import type { WhatsAppAiRequest } from "../src/ai-provider.js";

const url = process.env.FAIR_TEST_DATABASE_URL;
describe.skipIf(!url)("actual worker tenant fairness", () => {
  it("ingests and sends tenantB while tenantA model remains blocked across two workers", async () => {
    if (!url) throw new Error("Owned fair fixture required");
    const target = new URL(url);
    if (
      target.hostname !== "127.0.0.1" ||
      target.port !== "55480" ||
      !/^\/oron_fair_[a-f0-9]{32}$/u.test(target.pathname)
    )
      throw new Error("Independent local fair fixture only");
    const admin = postgres(url, { max: 2, prepare: false });
    const fixtures: {
      tenant: string;
      account: string;
      from: string;
      conversation: string;
    }[] = [];
    let releaseSlow: () => void = () => {
      throw new Error("uninitialized slow model");
    };
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const state = { aStarted: false };
    const modelCalls: string[] = [];
    const sent: string[] = [];
    const workerTarget = new URL(url);
    workerTarget.searchParams.set("options", "-c role=platform_messaging");
    const model = {
      decide: async (request: WhatsAppAiRequest) => {
        const label = request.contactContext?.contact.name ?? "missing";
        modelCalls.push(label);
        if (label === "Synthetic A") {
          state.aStarted = true;
          await slow;
        }
        return { action: "reply" as const, text: "Hello! How can I help?" };
      },
    };
    const meta = {
      name: "meta" as const,
      send: async (request: WhatsAppSendRequest) => {
        await request.beforeAttempt?.();
        sent.push(request.recipient);
        return { messageId: `synthetic-send-${randomUUID()}` };
      },
    };
    const stores = ["one", "two"].map((label) =>
      createMessagingStore(
        workerTarget.toString(),
        `fair-worker-${label}`,
        { simulator: new SimulatorWhatsAppProvider(), meta },
        undefined,
        { aiProvider: model, realWhatsAppEnabled: true },
      ),
    );
    try {
      const firstStore = stores[0];
      const secondStore = stores[1];
      if (!firstStore || !secondStore)
        throw new Error("Two worker stores required");
      expect(await firstStore.isReady()).toBe(true);
      await admin`revoke execute on function ops.claim_fair_ai_reply(text) from platform_messaging`;
      try {
        expect(await firstStore.isReady()).toBe(false);
      } finally {
        await admin`grant execute on function ops.claim_fair_ai_reply(text) to platform_messaging`;
      }
      expect(await firstStore.isReady()).toBe(true);
      for (let index = 0; index < 2; index++) {
        const tenant = randomUUID(),
          user = randomUUID(),
          channel = randomUUID(),
          contact = randomUUID(),
          conversation = randomUUID();
        const account = `synthetic-account-${randomUUID()}`,
          from = `1202555000${String(index)}`;
        await admin.begin(async (tx) => {
          await tx`insert into public.tenants(id,name,slug,status) values(${tenant}::uuid,${index === 0 ? "Synthetic A tenant" : "Synthetic B tenant"},${`fair-worker-${tenant}`},'active')`;
          await tx`insert into public.users(id,email,status) values(${user}::uuid,${`${user}@example.invalid`},'active')`;
          await tx`insert into public.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner')`;
          await tx`select set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${user},true),set_config('app.current_role','owner',true)`;
          await tx`insert into crm.tenant_settings(tenant_id,locale,timezone) values(${tenant}::uuid,'en','UTC')`;
          await tx`insert into platform.tenant_remediation_flags(tenant_id,flag_key,enabled) values(${tenant}::uuid,'queue_priority',true)`;
          await tx`insert into messaging.channels(id,tenant_id,kind,provider,provider_account_id,display_address,status,configuration) values(${channel}::uuid,${tenant}::uuid,'whatsapp','meta',${account},'Synthetic account','active',${tx.json({ phoneNumberId: account, wabaId: "synthetic-waba", graphApiVersion: "v26.0" })})`;
          await tx`insert into crm.contacts(id,tenant_id,created_by_user_id,name,whatsapp_consent) values(${contact}::uuid,${tenant}::uuid,${user}::uuid,${index === 0 ? "Synthetic A" : "Synthetic B"},'granted')`;
          await tx`insert into crm.contact_channel_identities(tenant_id,contact_id,channel,normalized_value,display_value,validation_status,is_primary) values(${tenant}::uuid,${contact}::uuid,'whatsapp',${"+" + from},${"+" + from},'valid',true)`;
          const profile = await createAgentProfileDraft(tx, user, {
            name: "Synthetic fairness agent",
            systemPrompt: "Help customers safely.",
            locale: "en",
            channels: ["whatsapp"],
          });
          const versions = await tx<
            { id: string }[]
          >`update agents.agent_profile_versions set published_at=clock_timestamp(),validation_status='valid' where agent_profile_id=${profile}::uuid returning id`;
          const version = versions[0]?.id;
          if (!version) throw new Error("Synthetic agent version absent");
          await tx`insert into messaging.conversations(id,tenant_id,channel_id,contact_id,status,ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at) values(${conversation}::uuid,${tenant}::uuid,${channel}::uuid,${contact}::uuid,'open','ai',${version}::uuid,${user}::uuid,clock_timestamp())`;
        });
        fixtures.push({ tenant, account, from, conversation });
      }
      const accept = async (index: number) => {
        const fixture = fixtures[index];
        if (!fixture) throw new Error("Missing synthetic tenant");
        const message = randomUUID();
        await admin`select ops.accept_whatsapp_inbound(${fixture.account},${message},'whatsapp.message.text',${admin.json({ providerAccountId: fixture.account, providerEventId: message, providerMessageId: message, from: "+" + fixture.from, profileName: index === 0 ? "Synthetic A" : "Synthetic B", text: "Hi!", contentType: "text", occurredAt: new Date().toISOString() })})`;
      };
      await accept(0);
      await firstStore.processAvailable();
      for (let pass = 0; pass < 20 && !state.aStarted; pass++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(state.aStarted).toBe(true);
      await accept(1);
      let bSent = false;
      for (let pass = 0; pass < 30; pass++) {
        await Promise.all(stores.map((store) => store.processAvailable()));
        bSent = sent.some((recipient) => recipient.includes("12025550001"));
        if (bSent) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(bSent).toBe(true);
      expect(
        sent.filter((recipient) => recipient.includes("12025550001")),
      ).toHaveLength(1);
      expect(sent.some((recipient) => recipient.includes("12025550000"))).toBe(
        false,
      );
      expect(
        modelCalls.filter((label) => label === "Synthetic A"),
      ).toHaveLength(1);
      expect(
        modelCalls.filter((label) => label === "Synthetic B"),
      ).toHaveLength(1);
      const b = fixtures[1];
      if (!b) throw new Error("Missing B");
      const visible = await admin<
        { count: string }[]
      >`select count(*) from messaging.messages where tenant_id=${b.tenant}::uuid and direction='inbound'`;
      expect(Number(visible[0]?.count)).toBe(1);
      releaseSlow();
      await Promise.all(stores.map((store) => store.drainReplies()));
    } finally {
      releaseSlow();
      await Promise.all(stores.map((store) => store.close()));
      await admin.end();
    }
  }, 30000);
});
