import { createHmac, randomUUID } from "node:crypto";
import {
  acceptWhatsAppWebhook,
  InvalidWhatsAppPayloadError,
  InvalidWhatsAppSignatureError,
  parseWhatsAppCoexistenceEnvelopes,
  parseWhatsAppMessageEnvelopes,
} from "@or-on/crm";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createMessagingStore } from "../src/database.js";
import { SimulatorWhatsAppProvider } from "../src/providers.js";

const secret = "fictional-coexistence-test-secret";
const at = "1739230955",
  business = "15550001111",
  customer = "15550002222";
function body(
  waba: string,
  phone: string,
  field: string,
  value: Record<string, unknown>,
) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: waba,
        changes: [
          {
            field,
            value: {
              metadata: {
                phone_number_id: phone,
                display_phone_number: business,
              },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

describe("documented Coexistence field dispatch", () => {
  it("never interprets history media followups as live inbound", () => {
    const payload = body("100", "200", "history", {
      messages: [
        {
          id: "historical",
          from: customer,
          timestamp: at,
          type: "image",
          image: { id: "media" },
        },
      ],
    });
    expect(parseWhatsAppMessageEnvelopes(payload)).toEqual([]);
    expect(parseWhatsAppCoexistenceEnvelopes(payload)).toHaveLength(1);
  });
  it("bounds large history receipts and fingerprints stable key ordering", () => {
    const messages = Array.from({ length: 205 }, (_, i) => ({
      id: `message-${String(i)}`,
      from: customer,
      timestamp: at,
      type: "text",
      text: { body: "Fictional" },
    }));
    const payload = body("100", "200", "history", {
      history: [
        {
          metadata: { phase: 0, chunk_order: 1, progress: 55 },
          threads: [{ id: customer, messages }],
        },
      ],
    });
    const first = parseWhatsAppCoexistenceEnvelopes(payload);
    expect(first).toHaveLength(3);
    const reversed = JSON.parse(
      JSON.stringify(payload, (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value,
      ),
    ) as unknown;
    expect(
      parseWhatsAppCoexistenceEnvelopes(reversed).map((x) => x.providerEventId),
    ).toEqual(first.map((x) => x.providerEventId));
    expect(new Set(first.map((x) => x.providerEventId)).size).toBe(3);
  });
});

const url = process.env.OPENING_MENU_TEST_DATABASE_URL;
describe.skipIf(!url)("owned Coexistence receipt and import pipeline", () => {
  it("isolates accounts, imports burst history without automation, preserves human echoes and disconnects only the bound account", async () => {
    if (!url) throw new Error("Owned fixture required");
    const target = new URL(url);
    if (
      target.hostname !== "127.0.0.1" ||
      target.port !== "55480" ||
      !/^\/oron_crm_[a-f0-9]{32}$/.test(target.pathname)
    )
      throw new Error("Owned loopback fixture only");
    const admin = postgres(url, { max: 2, prepare: false });
    const tenant = randomUUID(),
      channel = randomUUID(),
      otherTenant = randomUUID(),
      otherChannel = randomUUID();
    const phone = `7${Date.now().toString()}`,
      otherPhone = `8${Date.now().toString()}`,
      waba = `6${Date.now().toString()}`;
    target.searchParams.set("options", "-c role=platform_web");
    const webUrl = target.toString();
    target.searchParams.set("options", "-c role=platform_messaging");
    let sends = 0,
      model = 0;
    const store = createMessagingStore(
      target.toString(),
      `coexistence-${tenant}`,
      {
        simulator: new SimulatorWhatsAppProvider(),
        meta: {
          name: "meta",
          send: () => {
            sends++;
            return Promise.resolve({ messageId: "forbidden" });
          },
        },
      },
      undefined,
      {
        realWhatsAppEnabled: true,
        aiProvider: {
          decide: () => {
            model++;
            return Promise.resolve({ action: "reply", text: "Forbidden" });
          },
        },
      },
    );
    async function accept(
      field: string,
      value: Record<string, unknown>,
      overrides: { waba?: string; phone?: string; signature?: string } = {},
    ) {
      const raw = Buffer.from(
        JSON.stringify(
          body(overrides.waba ?? waba, overrides.phone ?? phone, field, value),
        ),
      );
      return acceptWhatsAppWebhook(
        webUrl,
        raw,
        overrides.signature ??
          `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
        secret,
        phone,
        undefined,
        waba,
      );
    }
    async function drain() {
      for (let pass = 0; pass < 5; pass++) {
        await store.processAvailable();
        await store.drainReplies();
      }
    }
    try {
      for (const [id, ch, account] of [
        [tenant, channel, phone],
        [otherTenant, otherChannel, otherPhone],
      ] as const) {
        await admin`INSERT INTO public.tenants(id,name,slug,status) VALUES(${id}::uuid,'Fictional Coexistence',${id},'active')`;
        await admin`INSERT INTO messaging.channels(id,tenant_id,kind,provider,provider_account_id,display_address,status) VALUES(${ch}::uuid,${id}::uuid,'whatsapp','meta',${account},'Fictional','active')`;
        await admin`INSERT INTO platform.whatsapp_coexistence_accounts(tenant_id,channel_id,waba_id,phone_number_id,business_phone_number) VALUES(${id}::uuid,${ch}::uuid,${waba},${account},${business})`;
      }
      await expect(
        accept("smb_message_echoes", {}, { signature: "sha256=invalid" }),
      ).rejects.toBeInstanceOf(InvalidWhatsAppSignatureError);
      await expect(
        accept("history", {}, { phone: otherPhone }),
      ).rejects.toBeInstanceOf(InvalidWhatsAppPayloadError);
      await expect(
        accept("history", {}, { waba: "999999" }),
      ).rejects.toBeInstanceOf(InvalidWhatsAppPayloadError);
      await expect(
        accept("account_update", {
          phone_number: "15559999999",
          event: "PARTNER_REMOVED",
        }),
      ).rejects.toThrow("account mismatch");
      const mismatched = Buffer.from(
        JSON.stringify(body("999999", phone, "history", {})),
      );
      await expect(
        acceptWhatsAppWebhook(
          webUrl,
          mismatched,
          `sha256=${createHmac("sha256", secret).update(mismatched).digest("hex")}`,
          secret,
          phone,
          undefined,
          "999999",
        ),
      ).rejects.toThrow("unknown WhatsApp coexistence binding");
      expect(
        await admin`SELECT id FROM ops.inbound_events WHERE tenant_id=${tenant}::uuid`,
      ).toHaveLength(0);
      // Default off: receipt is durable; the worker performs no import.
      await accept("history", {
        history: [
          {
            threads: [
              {
                id: customer,
                messages: [
                  {
                    id: "off",
                    from: customer,
                    timestamp: at,
                    type: "text",
                    text: { body: "Not imported while disabled" },
                  },
                ],
              },
            ],
          },
        ],
      });
      await drain();
      expect(
        await admin`SELECT id FROM messaging.messages WHERE tenant_id=${tenant}::uuid`,
      ).toHaveLength(0);
      const disabledPending = await accept("history", {
        history: [
          {
            threads: [
              {
                id: customer,
                messages: [
                  {
                    id: "off-pending",
                    from: customer,
                    timestamp: at,
                    type: "text",
                    text: { body: "Remain retained only after enabling" },
                  },
                ],
              },
            ],
          },
        ],
      });
      await admin`UPDATE platform.whatsapp_coexistence_accounts SET enabled=true WHERE tenant_id=${tenant}::uuid`;
      await drain();
      expect(
        await admin`SELECT id FROM messaging.messages WHERE tenant_id=${tenant}::uuid`,
      ).toHaveLength(0);
      expect(
        (
          await admin<
            { payload: Record<string, unknown> }[]
          >`SELECT payload FROM ops.inbound_events WHERE id=${disabledPending.eventIds[0] ?? ""}::uuid`
        )[0]?.payload.importEnabled,
      ).toBe(false);
      const messages = Array.from({ length: 205 }, (_, index) => ({
        id: `history-${tenant}-${String(index)}`,
        from: index % 2 === 0 ? customer : business,
        timestamp: String(Number(at) + index),
        type: index === 0 ? "media_placeholder" : "text",
        ...(index === 0
          ? {}
          : { text: { body: "Fictional historical message" } }),
      }));
      const history = {
        history: [
          {
            metadata: { phase: 0, chunk_order: 1, progress: 100 },
            threads: [{ id: customer, messages }],
          },
        ],
      };
      const one = await accept("history", history),
        duplicate = await accept("history", history);
      expect(one.eventIds).toEqual(duplicate.eventIds);
      expect(one.envelopes).toBe(3);
      await drain();
      const imported = await admin<
        { id: string; direction: string; sender_type: string }[]
      >`SELECT id,direction,sender_type FROM messaging.messages WHERE tenant_id=${tenant}::uuid`;
      expect(imported).toHaveLength(205);
      expect(
        imported
          .filter((x) => x.direction === "outbound")
          .every((x) => x.sender_type === "user"),
      ).toBe(true);
      const conversations = await admin<
        {
          id: string;
          customer_service_window_expires_at: Date | null;
          status: string;
          unread_count: number;
        }[]
      >`SELECT id,customer_service_window_expires_at,status,unread_count FROM messaging.conversations WHERE tenant_id=${tenant}::uuid`;
      expect(conversations).toHaveLength(1);
      expect(conversations[0]).toMatchObject({
        customer_service_window_expires_at: null,
        status: "closed",
        unread_count: 0,
      });
      expect(
        (
          await admin<
            { whatsapp_consent: string }[]
          >`SELECT whatsapp_consent FROM crm.contacts WHERE tenant_id=${tenant}::uuid`
        )[0]?.whatsapp_consent,
      ).toBe("unknown");
      // Same-wamid media update cannot invoke OCR, ASR, media download or AI.
      await accept("history", {
        messages: [
          {
            id: `history-${tenant}-0`,
            from: customer,
            timestamp: at,
            type: "image",
            image: {
              id: "fictional-media",
              mime_type: "image/jpeg",
              caption: "Historical media",
            },
          },
        ],
      });
      await drain();
      expect(
        (
          await admin<
            {
              content_type: string;
              object_id: string | null;
              structured_content: Record<string, unknown>;
            }[]
          >`SELECT content_type,object_id,structured_content FROM messaging.messages WHERE tenant_id=${tenant}::uuid AND provider_message_id=${`history-${tenant}-0`}`
        )[0],
      ).toMatchObject({
        content_type: "image",
        object_id: null,
        structured_content: {
          retrievalStatus: "unavailable",
          providerMediaId: "fictional-media",
        },
      });
      const conversation = conversations[0]?.id;
      if (!conversation) throw new Error("Imported conversation missing");
      const user = randomUUID(),
        profile = randomUUID(),
        version = randomUUID();
      await admin`INSERT INTO public.users(id,email,status) VALUES(${user}::uuid,${`${user}@example.invalid`},'active')`;
      await admin`INSERT INTO agents.agent_profiles(id,tenant_id,name,created_by_user_id) VALUES(${profile}::uuid,${tenant}::uuid,'Fictional Coexistence',${user}::uuid)`;
      await admin`INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,system_prompt,locale,channel_capabilities,tool_permissions,channel_configuration,escalation_configuration,validation_status,created_by_user_id,published_at) VALUES(${version}::uuid,${tenant}::uuid,${profile}::uuid,1,'Fictional fixture','en',ARRAY['whatsapp'],'[]','{}','{}','valid',${user}::uuid,clock_timestamp())`;
      await admin.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant',${tenant},true)`;
        await tx`UPDATE messaging.conversations SET ownership_mode='ai',ai_agent_profile_version_id=${version}::uuid,ai_enabled_by_user_id=${user}::uuid,ai_enabled_at=clock_timestamp() WHERE id=${conversation}::uuid`;
      });
      await admin`INSERT INTO messaging.messages(tenant_id,conversation_id,direction,sender_type,content_type,content_text,provider,provider_message_id,status) VALUES(${tenant}::uuid,${conversation}::uuid,'outbound','agent','text','Cloud send','meta',${`cloud-${tenant}`},'sent')`;
      await accept("smb_message_echoes", {
        message_echoes: [
          {
            id: `cloud-${tenant}`,
            from: `+${business}`,
            to: `+${customer}`,
            timestamp: at,
            type: "text",
            text: { body: "Cloud send" },
          },
        ],
      });
      await drain();
      expect(
        (
          await admin<
            { ownership_mode: string }[]
          >`SELECT ownership_mode FROM messaging.conversations WHERE id=${conversation}::uuid`
        )[0]?.ownership_mode,
      ).toBe("ai");
      const echo = {
        message_echoes: [
          {
            id: `echo-${tenant}`,
            from: business,
            to: customer,
            timestamp: String(Number(at) + 300),
            type: "text",
            text: { body: "Human app reply" },
          },
        ],
      };
      await accept("smb_message_echoes", echo);
      // Fence already committed before the worker imports the human message.
      expect(
        (
          await admin<
            { ownership_mode: string }[]
          >`SELECT ownership_mode FROM messaging.conversations WHERE id=${conversation}::uuid`
        )[0]?.ownership_mode,
      ).toBe("human");
      await Promise.all([
        accept("smb_message_echoes", echo),
        accept("smb_message_echoes", echo),
      ]);
      await drain();
      expect(
        await admin<
          { sender_type: string; provider_payload: Record<string, unknown> }[]
        >`SELECT sender_type,provider_payload FROM messaging.messages WHERE tenant_id=${tenant}::uuid AND provider_message_id=${`echo-${tenant}`}`,
      ).toMatchObject([
        {
          sender_type: "user",
          provider_payload: { origin: "whatsapp_business_app" },
        },
      ]);
      // Provider replay cannot re-take control after a later reviewed AI resume.
      await admin.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant',${tenant},true)`;
        await tx`UPDATE messaging.conversations SET ownership_mode='ai' WHERE id=${conversation}::uuid`;
      });
      await accept("smb_message_echoes", echo);
      await drain();
      expect(
        (
          await admin<
            { ownership_mode: string }[]
          >`SELECT ownership_mode FROM messaging.conversations WHERE id=${conversation}::uuid`
        )[0]?.ownership_mode,
      ).toBe("ai");
      const earlyMedia = await accept("history", {
        messages: [
          {
            id: `early-${tenant}`,
            from: customer,
            timestamp: at,
            type: "audio",
            audio: { id: "fictional-audio", mime_type: "audio/ogg" },
          },
        ],
      });
      await drain();
      expect(
        (
          await admin<
            { status: string; last_error_safe: string }[]
          >`SELECT status,last_error_safe FROM ops.inbound_events WHERE id=${earlyMedia.eventIds[0] ?? ""}::uuid`
        )[0],
      ).toMatchObject({
        status: "failed",
        last_error_safe: "coexistence media awaits history message",
      });
      await accept("history", {
        history: [
          {
            threads: [
              {
                id: customer,
                messages: [
                  {
                    id: `early-${tenant}`,
                    from: customer,
                    timestamp: at,
                    type: "media_placeholder",
                  },
                ],
              },
            ],
          },
        ],
      });
      await drain();
      await admin`UPDATE ops.inbound_events SET available_at=clock_timestamp() WHERE id=${earlyMedia.eventIds[0] ?? ""}::uuid`;
      await drain();
      expect(
        (
          await admin<
            { content_type: string }[]
          >`SELECT content_type FROM messaging.messages WHERE tenant_id=${tenant}::uuid AND provider_message_id=${`early-${tenant}`}`
        )[0]?.content_type,
      ).toBe("audio");
      await accept("history", {
        history: [{ errors: [{ code: 2593109, title: "History declined" }] }],
      });
      await drain();
      // Contact removals are tombstones, never destructive CRM contact deletes;
      // out-of-order older adds cannot resurrect the app-contact state.
      await accept("smb_app_state_sync", {
        state_sync: [
          {
            type: "contact",
            action: "add",
            contact: {
              phone_number: customer,
              full_name: "Fictional app contact",
            },
            metadata: { timestamp: at },
          },
        ],
      });
      await accept("smb_app_state_sync", {
        state_sync: [
          {
            type: "contact",
            action: "remove",
            contact: { phone_number: customer },
            metadata: { timestamp: String(Number(at) + 1) },
          },
        ],
      });
      await accept("smb_app_state_sync", {
        state_sync: [
          {
            type: "contact",
            action: "add",
            contact: { phone_number: customer },
            metadata: { timestamp: String(Number(at) - 1) },
          },
        ],
      });
      await drain();
      expect(
        (
          await admin<
            { state: string }[]
          >`SELECT state FROM messaging.whatsapp_app_contacts WHERE tenant_id=${tenant}::uuid`
        )[0]?.state,
      ).toBe("remove");
      expect(
        await admin`SELECT id FROM crm.contacts WHERE tenant_id=${tenant}::uuid`,
      ).toHaveLength(1);
      await accept("account_update", {
        event: "PARTNER_REMOVED",
        phone_number: `+${business}`,
      });
      expect(
        (
          await admin<
            { status: string }[]
          >`SELECT status FROM messaging.channels WHERE id=${channel}::uuid`
        )[0]?.status,
      ).toBe("revoked");
      expect(
        (
          await admin<
            { status: string }[]
          >`SELECT status FROM messaging.channels WHERE id=${otherChannel}::uuid`
        )[0]?.status,
      ).toBe("active");
      await accept("account_update", { event: "ACCOUNT_RECONNECTED" });
      await drain();
      expect(
        (
          await admin<
            { status: string }[]
          >`SELECT status FROM messaging.channels WHERE id=${channel}::uuid`
        )[0]?.status,
      ).toBe("revoked");
      expect(
        await admin`SELECT id FROM ops.jobs WHERE tenant_id=${tenant}::uuid`,
      ).toHaveLength(0);
      expect(
        await admin`SELECT message_id FROM messaging.inbound_message_origins WHERE tenant_id=${tenant}::uuid`,
      ).toHaveLength(0);
      expect(
        await admin`SELECT id FROM ops.inbound_events WHERE tenant_id=${tenant}::uuid AND status<>'processed'`,
      ).toHaveLength(0);
      expect(sends).toBe(0);
      expect(model).toBe(0);
    } finally {
      await store.close();
      await admin.end();
    }
  }, 120000);
});
