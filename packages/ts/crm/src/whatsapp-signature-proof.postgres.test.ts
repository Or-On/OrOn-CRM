import { randomUUID, createHmac, createHash } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  acceptWhatsAppWebhook,
  InvalidWhatsAppSignatureError,
} from "./webhook-store.js";
import { parseWhatsAppMessageEnvelopes } from "./webhook.js";
const url = process.env.CRM_TEST_DATABASE_URL;
describe.skipIf(!url)("separate signed webhook memory proof PostgreSQL", () => {
  it("only verified server HMAC path attests; default absent and failed proof leave normal durable acceptance", async () => {
    if (!url) throw Error("owned fixture required");
    const parsed = new URL(url);
    if (
      parsed.hostname !== "127.0.0.1" ||
      parsed.port !== "55480" ||
      !/^\/oron_(?:crm|ui_preview)_[a-f0-9]{32}$/u.test(parsed.pathname)
    )
      throw Error("owned loopback only");
    const db = postgres(url, { max: 1, prepare: false }),
      channel = randomUUID(),
      account = "910101" + String(Date.now());
    const tenant = (
      await db<
        { tenant_id: string }[]
      >`SELECT tenant_id FROM agents.agent_profile_versions WHERE published_at IS NOT NULL LIMIT 1`
    )[0]?.tenant_id;
    if (!tenant) throw Error("fictional tenant required");
    await db`INSERT INTO messaging.channels(id,tenant_id,kind,provider,display_address,provider_account_id,status) VALUES(${channel}::uuid,${tenant}::uuid,'whatsapp','meta','Synthetic signature proof',${account},'active')`;
    const secret = "synthetic-hmac-secret-for-owned-test",
      events: string[] = [];
    const body = (id: string) =>
      Buffer.from(
        JSON.stringify({
          object: "whatsapp_business_account",
          entry: [
            {
              changes: [
                {
                  value: {
                    metadata: { phone_number_id: account },
                    contacts: [
                      { profile: { name: "Fictional" }, wa_id: "15550123456" },
                    ],
                    messages: [
                      {
                        id,
                        from: "15550123456",
                        type: "text",
                        text: { body: "Synthetic signed statement" },
                        timestamp: "1700000000",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      );
    const sign = (raw: Buffer) =>
      "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const invalid = body("invalid-" + randomUUID());
      await expect(
        acceptWhatsAppWebhook(
          url,
          invalid,
          "sha256=" + "0".repeat(64),
          secret,
          account,
          url,
        ),
      ).rejects.toBeInstanceOf(InvalidWhatsAppSignatureError);
      expect(
        await db`SELECT * FROM agents.whatsapp_verified_receipts WHERE provider_account_id=${account}`,
      ).toHaveLength(0);
      const normal = body("normal-" + randomUUID());
      const accepted = await acceptWhatsAppWebhook(
        url,
        normal,
        sign(normal),
        secret,
        account,
      );
      events.push(...accepted.eventIds);
      expect(accepted.envelopes).toBe(1);
      expect(
        await db`SELECT * FROM agents.whatsapp_verified_receipts WHERE provider_account_id=${account}`,
      ).toHaveLength(0);
      const signed = body("verified-" + randomUUID());
      const verified = await acceptWhatsAppWebhook(
        url,
        signed,
        sign(signed),
        secret,
        account,
        url,
      );
      events.push(...verified.eventIds);
      const proof = await db<
        { raw_body_digest: string }[]
      >`SELECT raw_body_digest FROM agents.whatsapp_verified_receipts WHERE inbound_event_id=${verified.eventIds[0] ?? ""}::uuid`;
      expect(proof).toEqual([
        { raw_body_digest: createHash("sha256").update(signed).digest("hex") },
      ]);
      const retry = await acceptWhatsAppWebhook(
        url,
        signed,
        sign(signed),
        secret,
        account,
        url,
      );
      expect(retry.eventIds).toEqual(verified.eventIds);
      expect(
        await db`SELECT * FROM agents.whatsapp_verified_receipts WHERE inbound_event_id=${verified.eventIds[0] ?? ""}::uuid`,
      ).toHaveLength(1);
      for (const tamper of [
        { from: "15550999999" },
        { text: "UNSIGNED_OLD_CLAIM" },
      ]) {
        const collision = body("collision-" + randomUUID());
        const envelope = parseWhatsAppMessageEnvelopes(
          JSON.parse(collision.toString("utf8")),
        )[0];
        if (!envelope) throw Error("synthetic envelope missing");
        const forged = {
          providerAccountId: envelope.providerAccountId,
          providerEventId: envelope.providerEventId,
          providerMessageId: envelope.providerMessageId,
          from: envelope.from,
          profileName: envelope.profileName,
          text: envelope.text,
          contentType: envelope.contentType ?? "text",
          providerMessageType: envelope.providerMessageType,
          ...(envelope.occurredAt === undefined
            ? {}
            : { occurredAt: envelope.occurredAt }),
          ...tamper,
        };
        const seeded = await db.begin(async (sql) => {
          await sql`SET LOCAL ROLE platform_messaging`;
          return sql<
            { id: string }[]
          >`SELECT (ops.accept_whatsapp_inbound(${account},${envelope.providerEventId},'whatsapp.message.text',${sql.json(forged)})).id`;
        });
        const id = seeded[0]?.id;
        if (!id) throw Error("synthetic preseed missing");
        events.push(id);
        const legitimate = await acceptWhatsAppWebhook(
          url,
          collision,
          sign(collision),
          secret,
          account,
          url,
        );
        expect(legitimate.eventIds).toEqual([id]);
        expect(
          await db`SELECT * FROM agents.whatsapp_verified_receipts WHERE inbound_event_id=${id}::uuid`,
        ).toHaveLength(0);
      }
      const unavailable = body("unavailable-" + randomUUID());
      const closed = new URL(url);
      closed.port = "55481";
      const retained = await acceptWhatsAppWebhook(
        url,
        unavailable,
        sign(unavailable),
        secret,
        account,
        closed.toString(),
      );
      events.push(...retained.eventIds);
      expect(retained.envelopes).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        "WhatsApp memory signature evidence unavailable",
        { reason: "verification_persistence_failed" },
      );
      expect(
        await db`SELECT * FROM agents.whatsapp_verified_receipts WHERE inbound_event_id=${retained.eventIds[0] ?? ""}::uuid`,
      ).toHaveLength(0);
    } finally {
      warn.mockRestore();
      for (const event of events) {
        await db`DELETE FROM agents.whatsapp_verified_receipts WHERE inbound_event_id=${event}::uuid`;
        await db`DELETE FROM ops.inbound_events WHERE id=${event}::uuid`;
      }
      await db`DELETE FROM messaging.channels WHERE id=${channel}::uuid`;
      await db.end();
    }
  });
});
