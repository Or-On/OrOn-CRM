import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseWhatsAppTextEnvelopes,
  parseWhatsAppStatusEnvelopes,
  verifyWhatsAppSignature,
} from "./webhook.js";

describe("WhatsApp webhook boundary", () => {
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
        text: "Hello",
      },
    ]);
    expect(parseWhatsAppTextEnvelopes({ unexpected: true })).toEqual([]);
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
