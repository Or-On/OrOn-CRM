import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseStoredWhatsAppEnvelope,
  parseWhatsAppMessageEnvelopes,
  parseWhatsAppTextEnvelopes,
  parseWhatsAppStatusEnvelopes,
  verifyWhatsAppSignature,
} from "./webhook.js";

describe("WhatsApp webhook boundary", () => {
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
});
