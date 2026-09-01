import { createHmac, timingSafeEqual } from "node:crypto";

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function verifyWhatsAppSignature(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=") || appSecret.length < 16) {
    return false;
  }
  const suppliedHex = signatureHeader.slice(7);
  if (!/^[0-9a-f]{64}$/u.test(suppliedHex)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const supplied = Buffer.from(suppliedHex, "hex");
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export interface WhatsAppInboundEnvelope {
  readonly providerAccountId: string;
  readonly providerEventId: string;
  readonly providerMessageId: string;
  readonly from: string;
  readonly profileName: string;
  readonly text: string;
}

export function parseWhatsAppTextEnvelopes(
  payload: unknown,
): readonly WhatsAppInboundEnvelope[] {
  const root = record(payload);
  if (root === undefined) return [];
  const results: WhatsAppInboundEnvelope[] = [];

  for (const entryValue of array(root.entry)) {
    const entry = record(entryValue);
    if (entry === undefined) continue;
    const entryId = typeof entry.id === "string" ? entry.id : "unknown";

    for (const changeValue of array(entry.changes)) {
      const change = record(changeValue);
      const value = record(change?.value);
      if (value === undefined) continue;
      const metadata = record(value.metadata);
      const accountId =
        typeof metadata?.phone_number_id === "string"
          ? metadata.phone_number_id
          : undefined;
      const contacts = array(value.contacts);

      for (const messageValue of array(value.messages)) {
        const message = record(messageValue);
        const textValue = record(message?.text);
        const id = typeof message?.id === "string" ? message.id : undefined;
        const from =
          typeof message?.from === "string" ? message.from : undefined;
        const body =
          typeof textValue?.body === "string" ? textValue.body : undefined;
        if (
          accountId === undefined ||
          id === undefined ||
          from === undefined ||
          body === undefined
        )
          continue;
        const contact = record(contacts[0]);
        const profile = record(contact?.profile);
        const profileName =
          typeof profile?.name === "string" ? profile.name : from;
        results.push({
          providerAccountId: accountId,
          providerEventId: `${entryId}:${id}`,
          providerMessageId: id,
          from: `+${from.replace(/^\+/u, "")}`,
          profileName,
          text: body,
        });
      }
    }
  }
  return results;
}
