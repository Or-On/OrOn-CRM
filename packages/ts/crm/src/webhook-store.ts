import postgres from "postgres";

import {
  parseWhatsAppMessageEnvelopes,
  parseWhatsAppStatusEnvelopes,
  verifyWhatsAppSignature,
} from "./webhook.js";

interface AcceptedEventRow {
  id: string;
}

export interface AcceptedWhatsAppWebhook {
  readonly eventIds: readonly string[];
  readonly envelopes: number;
}

export class InvalidWhatsAppSignatureError extends Error {}
export class InvalidWhatsAppPayloadError extends Error {}

export async function acceptWhatsAppWebhook(
  databaseUrl: string,
  rawBody: Uint8Array,
  signatureHeader: string | null,
  appSecret: string,
): Promise<AcceptedWhatsAppWebhook> {
  if (!verifyWhatsAppSignature(rawBody, signatureHeader, appSecret)) {
    throw new InvalidWhatsAppSignatureError("Invalid WhatsApp signature");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
  } catch (error) {
    throw new InvalidWhatsAppPayloadError("Invalid WhatsApp JSON payload", {
      cause: error,
    });
  }
  const envelopes = parseWhatsAppMessageEnvelopes(payload);
  const statuses = parseWhatsAppStatusEnvelopes(payload);
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const eventIds = await sql.begin(async (transaction) => {
      const ids: string[] = [];
      for (const envelope of envelopes) {
        const contentType = envelope.contentType ?? "text";
        const rows = await transaction<AcceptedEventRow[]>`
          SELECT (ops.accept_whatsapp_inbound(
            ${envelope.providerAccountId}, ${envelope.providerEventId},
            ${`whatsapp.message.${contentType}`}, ${transaction.json({
              providerAccountId: envelope.providerAccountId,
              providerEventId: envelope.providerEventId,
              providerMessageId: envelope.providerMessageId,
              from: envelope.from,
              profileName: envelope.profileName,
              text: envelope.text,
              contentType,
              ...(envelope.media === undefined
                ? {}
                : { media: envelope.media }),
              ...(envelope.location === undefined
                ? {}
                : { location: envelope.location }),
              ...(envelope.occurredAt === undefined
                ? {}
                : { occurredAt: envelope.occurredAt }),
            })}
          )).id
        `;
        const id = rows[0]?.id;
        if (id === undefined) throw new Error("webhook event insert failed");
        ids.push(id);
      }
      for (const status of statuses) {
        const rows = await transaction<AcceptedEventRow[]>`
          SELECT (ops.accept_whatsapp_inbound(
            ${status.providerAccountId}, ${status.providerEventId},
            'whatsapp.message.status', ${transaction.json({
              providerAccountId: status.providerAccountId,
              providerEventId: status.providerEventId,
              providerMessageId: status.providerMessageId,
              status: status.status,
              occurredAt: status.occurredAt,
              ...(status.errorCode === undefined
                ? {}
                : { errorCode: status.errorCode }),
            })}
          )).id
        `;
        const id = rows[0]?.id;
        if (id === undefined)
          throw new Error("webhook status event insert failed");
        ids.push(id);
      }
      return ids;
    });
    return { eventIds, envelopes: envelopes.length + statuses.length };
  } finally {
    await sql.end({ timeout: 2 });
  }
}
