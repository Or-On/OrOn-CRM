import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseStoredWhatsAppEnvelope,
  parseWhatsAppMessageEnvelopes,
  parseWhatsAppTextEnvelopes,
  parseWhatsAppStatusEnvelopes,
  verifyWhatsAppSignature,
} from "./webhook.js";
import {
  acceptWhatsAppWebhook,
  InvalidWhatsAppPayloadError,
} from "./webhook-store.js";
import {
  UNSUPPORTED_WHATSAPP_REPLY,
  whatsAppInboundHandling,
} from "./whatsapp-media-policy.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing synthetic fixture");
  return value;
}

describe("WhatsApp webhook boundary", () => {
  const batch = (messages: unknown[]) => ({
    entry: [
      {
        id: "synthetic-entry",
        changes: [
          {
            value: {
              metadata: { phone_number_id: "synthetic-account" },
              messages,
            },
          },
        ],
      },
    ],
  });
  const message = (type: string, content: unknown) => ({
    id: `wamid.synthetic.${type}`,
    from: "12025550199",
    type,
    [type]: content,
  });

  it("retains voice media identity without pretending the annotation is a transcript", () => {
    const envelope = parseWhatsAppMessageEnvelopes(
      batch([
        message("audio", { id: "synthetic-media", mime_type: "audio/ogg" }),
      ]),
    )[0];
    expect(envelope).toMatchObject({
      contentType: "audio",
      text: "[Voice note: transcription pending]",
      media: { id: "synthetic-media" },
    });
    expect(parseStoredWhatsAppEnvelope(envelope)).toEqual(envelope);
    expect(whatsAppInboundHandling(required(envelope))).toEqual({
      kind: "transcription_pending",
      mediaId: "synthetic-media",
    });
  });

  it("normalizes video, sticker, interactive replies, buttons and reactions into existing canonical types", () => {
    const envelopes = parseWhatsAppMessageEnvelopes(
      batch([
        message("video", {
          id: "synthetic-video",
          caption: "Synthetic caption",
        }),
        message("sticker", {
          id: "synthetic-sticker",
          mime_type: "image/webp",
        }),
        message("interactive", {
          type: "button_reply",
          button_reply: { id: "choice", title: "Quoted untrusted title" },
        }),
        {
          ...message("interactive", {
            type: "list_reply",
            list_reply: { id: "list", title: "List choice" },
          }),
          id: "wamid.list",
        },
        message("button", { payload: "choice-token", text: "Button text" }),
        message("reaction", { message_id: "wamid.prior", emoji: "👍" }),
      ]),
    );
    expect(envelopes.map((e) => e.contentType)).toEqual([
      "video",
      "image",
      "interactive",
      "interactive",
      "interactive",
      "event",
    ]);
    expect(envelopes[2]?.text).toBe("Quoted untrusted title");
    expect(envelopes[4]?.interaction).toEqual({
      id: "choice-token",
      title: "Button text",
    });
    for (const envelope of envelopes)
      expect(parseStoredWhatsAppEnvelope(envelope)).toEqual(envelope);
    expect(whatsAppInboundHandling(required(envelopes[1]))).toEqual({
      kind: "unsupported",
      replyText: UNSUPPORTED_WHATSAPP_REPLY,
    });
    expect(whatsAppInboundHandling(required(envelopes[5]))).toEqual({
      kind: "reaction",
      messageId: "wamid.prior",
      emoji: "👍",
    });
  });

  it("stores reaction removal and unsupported messages with explicit fallback routing", () => {
    const envelopes = parseWhatsAppMessageEnvelopes(
      batch([
        message("reaction", { message_id: "wamid.prior", emoji: "" }),
        message("contacts", {
          fictional: "untrusted body must not become a transcript",
        }),
        message("interactive", {
          type: "nfm_reply",
          nfm_reply: { response_json: '{"tenantId":"attacker"}' },
        }),
      ]),
    );
    expect(envelopes[0]?.text).toBe("[Reaction removed]");
    expect(envelopes[1]).toMatchObject({
      contentType: "event",
      providerMessageType: "contacts",
      text: "[Unsupported WhatsApp message: contacts]",
    });
    expect(whatsAppInboundHandling(required(envelopes[1]))).toEqual({
      kind: "unsupported",
      replyText: UNSUPPORTED_WHATSAPP_REPLY,
    });
    expect(envelopes[2]?.contentType).toBe("event");
    expect(whatsAppInboundHandling(required(envelopes[2]))).toEqual({
      kind: "unsupported",
      replyText: UNSUPPORTED_WHATSAPP_REPLY,
    });
  });

  it("rejects malformed or oversized messages individually while retaining valid neighbors", () => {
    const envelopes = parseWhatsAppMessageEnvelopes(
      batch([
        message("audio", { mime_type: "audio/ogg" }),
        message("interactive", {
          type: "button_reply",
          button_reply: { title: "Missing id" },
        }),
        message("text", { body: "x".repeat(65_537) }),
        { ...message("text", { body: "Bad sender" }), from: "not-a-phone" },
        message("button", { payload: "id", text: "x".repeat(1_025) }),
        message("text", { body: "Retained" }),
      ]),
    );
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.text).toBe("Retained");
    expect(
      parseStoredWhatsAppEnvelope({
        ...envelopes[0],
        text: "x".repeat(65_537),
      }),
    ).toBeUndefined();
    expect(
      parseStoredWhatsAppEnvelope({ ...envelopes[0], from: "+invalid" }),
    ).toBeUndefined();
  });

  it("does not borrow profile names from another sender in a signed mixed-account batch", () => {
    const payload = batch([message("text", { body: "One" })]);
    const first = required(required(payload.entry[0]).changes[0]).value;
    Object.assign(first, {
      contacts: [{ wa_id: "12025550200", profile: { name: "Other sender" } }],
    });
    required(payload.entry[0]).changes.push({
      value: {
        metadata: { phone_number_id: "other-account" },
        messages: [message("audio", { id: "second-media" })],
      },
    });
    const raw = Buffer.from(JSON.stringify(payload));
    const secret = "fictional-test-signature-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    expect(verifyWhatsAppSignature(raw, signature, secret)).toBe(true);
    const envelopes = parseWhatsAppMessageEnvelopes(JSON.parse(raw.toString()));
    expect(envelopes.map((e) => e.providerAccountId)).toEqual([
      "synthetic-account",
      "other-account",
    ]);
    expect(envelopes[0]?.profileName).toBe("+12025550199");
    expect(envelopes[0]).not.toHaveProperty("tenantId");
  });
  it("rejects a validly signed event sent to another account endpoint before database access", async () => {
    const secret = "fictional-app-secret-for-tests";
    const body = Buffer.from(
      JSON.stringify({
        entry: [
          {
            id: "entry",
            changes: [
              {
                value: {
                  metadata: { phone_number_id: "111" },
                  messages: [
                    {
                      id: "wamid.1",
                      from: "972501234567",
                      text: { body: "Hello" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    await expect(
      acceptWhatsAppWebhook(
        "postgresql://invalid.invalid/never-connect",
        body,
        signature,
        secret,
        "222",
      ),
    ).rejects.toBeInstanceOf(InvalidWhatsAppPayloadError);
  });

  it("preserves provider time and does not invent one for legacy or invalid envelopes", () => {
    const payload = (timestamp: string | undefined) => ({
      entry: [
        {
          id: "fixture",
          changes: [
            {
              value: {
                metadata: { phone_number_id: "fixture-phone" },
                messages: [
                  {
                    id: "fixture-message",
                    from: "12025550199",
                    text: { body: "Fictional text" },
                    timestamp,
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(
      parseWhatsAppTextEnvelopes(payload("1788364800"))[0]?.occurredAt,
    ).toBe("2026-09-02T16:00:00.000Z");
    expect(
      parseWhatsAppTextEnvelopes(payload(undefined))[0]?.occurredAt,
    ).toBeUndefined();
    expect(
      parseWhatsAppTextEnvelopes(payload("999999999999999"))[0]?.occurredAt,
    ).toBeUndefined();
  });
  it("verifies the exact raw request bytes", () => {
    const body = Buffer.from('{"entry":[]}');
    const secret = "fictional-app-secret-for-tests";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyWhatsAppSignature(body, signature, secret)).toBe(true);
    expect(
      verifyWhatsAppSignature(Buffer.from("changed"), signature, secret),
    ).toBe(false);
  });

  it("normalizes supported text envelopes without trusting unknown shapes", () => {
    expect(
      parseWhatsAppTextEnvelopes({
        entry: [
          {
            id: "entry",
            changes: [
              {
                value: {
                  metadata: { phone_number_id: "phone-id" },
                  contacts: [{ profile: { name: "Fictional Sender" } }],
                  messages: [
                    {
                      id: "wamid.1",
                      from: "972501234567",
                      text: { body: "Hello" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        providerAccountId: "phone-id",
        providerEventId: "entry:wamid.1",
        providerMessageId: "wamid.1",
        from: "+972501234567",
        profileName: "Fictional Sender",
        contentType: "text",
        text: "Hello",
      },
    ]);
    expect(parseWhatsAppTextEnvelopes({ unexpected: true })).toEqual([]);
  });

  it("normalizes media and locations while rejecting incomplete provider content", () => {
    const parsed = parseWhatsAppMessageEnvelopes({
      entry: [
        {
          id: "entry",
          changes: [
            {
              value: {
                metadata: { phone_number_id: "phone-id" },
                contacts: [{ profile: { name: "Fictional Sender" } }],
                messages: [
                  {
                    id: "wamid.image",
                    from: "972501234567",
                    type: "image",
                    image: {
                      id: "media-image",
                      mime_type: "image/jpeg",
                      sha256: "synthetic-hash",
                      caption: "Fault photo",
                    },
                  },
                  {
                    id: "wamid.location",
                    from: "972501234567",
                    type: "location",
                    location: {
                      latitude: 32.0853,
                      longitude: 34.7818,
                      name: "Synthetic store",
                      address: "1 Test Street",
                    },
                  },
                  {
                    id: "wamid.invalid",
                    from: "972501234567",
                    type: "image",
                    image: { caption: "Missing provider media id" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      contentType: "image",
      text: "Fault photo",
      media: { id: "media-image", mimeType: "image/jpeg" },
    });
    expect(parsed[1]).toMatchObject({
      contentType: "location",
      location: { latitude: 32.0853, longitude: 34.7818 },
    });
    expect(parseStoredWhatsAppEnvelope(parsed[0])).toEqual(parsed[0]);
    expect(
      parseStoredWhatsAppEnvelope({
        ...parsed[0],
        media: { caption: "missing id" },
      }),
    ).toBeUndefined();
  });

  it("normalizes delivery statuses with stable deduplication identifiers", () => {
    const payload = {
      entry: [
        {
          id: "waba",
          changes: [
            {
              value: {
                metadata: { phone_number_id: "1312069101984418" },
                statuses: [
                  {
                    id: "wamid.status",
                    status: "delivered",
                    timestamp: "1788364800",
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseWhatsAppStatusEnvelopes(payload)).toEqual([
      {
        providerAccountId: "1312069101984418",
        providerEventId: "waba:wamid.status:delivered:1788364800",
        providerMessageId: "wamid.status",
        status: "delivered",
        occurredAt: "2026-09-02T16:00:00.000Z",
      },
    ]);
  });
  it("skips out-of-range provider status timestamps instead of throwing on the batch", () => {
    const payload = batch([]);
    Object.assign(required(required(payload.entry[0]).changes[0]).value, {
      statuses: [
        {
          id: "wamid.oversized-date",
          status: "read",
          timestamp: "8640000000001",
        },
        { id: "wamid.retained", status: "read", timestamp: "1788364800" },
      ],
    });
    expect(
      parseWhatsAppStatusEnvelopes(payload).map((e) => e.providerMessageId),
    ).toEqual(["wamid.retained"]);
  });
});
