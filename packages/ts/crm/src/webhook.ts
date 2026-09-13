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
  readonly occurredAt?: string;
  readonly providerAccountId: string;
  readonly providerEventId: string;
  readonly providerMessageId: string;
  readonly from: string;
  readonly profileName: string;
  readonly text: string;
}

export interface WhatsAppStatusEnvelope {
  readonly providerAccountId: string;
  readonly providerEventId: string;
  readonly providerMessageId: string;
  readonly status: "sent" | "delivered" | "read" | "failed";
  readonly occurredAt: string;
  readonly errorCode?: string;
}

export function parseStoredWhatsAppStatusEnvelope(
  value: unknown,
): WhatsAppStatusEnvelope | undefined {
  const envelope = record(value);
  const status = envelope?.status;
  if (
    typeof envelope?.providerAccountId !== "string" ||
    typeof envelope.providerEventId !== "string" ||
    typeof envelope.providerMessageId !== "string" ||
    typeof envelope.occurredAt !== "string" ||
    (status !== "sent" &&
      status !== "delivered" &&
      status !== "read" &&
      status !== "failed")
  )
    return undefined;
  const errorCode =
    typeof envelope.errorCode === "string" ? envelope.errorCode : undefined;
  return {
    providerAccountId: envelope.providerAccountId,
    providerEventId: envelope.providerEventId,
    providerMessageId: envelope.providerMessageId,
    status,
    occurredAt: envelope.occurredAt,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

export function parseStoredWhatsAppEnvelope(
  value: unknown,
): WhatsAppInboundEnvelope | undefined {
  const envelope = record(value);
  if (
    typeof envelope?.providerAccountId !== "string" ||
    typeof envelope.providerEventId !== "string" ||
    typeof envelope.providerMessageId !== "string" ||
    typeof envelope.from !== "string" ||
    typeof envelope.profileName !== "string" ||
    typeof envelope.text !== "string"
  ) {
    return undefined;
  }
  return {
    ...(typeof envelope.occurredAt === "string" &&
    Number.isFinite(Date.parse(envelope.occurredAt))
      ? { occurredAt: envelope.occurredAt }
      : {}),
    providerAccountId: envelope.providerAccountId,
    providerEventId: envelope.providerEventId,
    providerMessageId: envelope.providerMessageId,
    from: envelope.from,
    profileName: envelope.profileName,
    text: envelope.text,
  };
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
        const timestamp =
          typeof message?.timestamp === "string"
            ? Number(message.timestamp)
            : NaN;
        const occurredAt =
          Number.isSafeInteger(timestamp) &&
          timestamp > 0 &&
          timestamp < 8_640_000_000_000
            ? new Date(timestamp * 1000).toISOString()
            : undefined;
        results.push({
          ...(occurredAt === undefined ? {} : { occurredAt }),
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

export function parseWhatsAppStatusEnvelopes(
  payload: unknown,
): readonly WhatsAppStatusEnvelope[] {
  const root = record(payload);
  if (root === undefined) return [];
  const results: WhatsAppStatusEnvelope[] = [];
  for (const entryValue of array(root.entry)) {
    const entry = record(entryValue);
    if (entry === undefined) continue;
    const entryId = typeof entry.id === "string" ? entry.id : "unknown";
    for (const changeValue of array(entry.changes)) {
      const value = record(record(changeValue)?.value);
      const metadata = record(value?.metadata);
      const accountId =
        typeof metadata?.phone_number_id === "string"
          ? metadata.phone_number_id
          : undefined;
      for (const statusValue of array(value?.statuses)) {
        const statusRecord = record(statusValue);
        const messageId =
          typeof statusRecord?.id === "string" ? statusRecord.id : undefined;
        const status = statusRecord?.status;
        const timestamp =
          typeof statusRecord?.timestamp === "string"
            ? statusRecord.timestamp
            : undefined;
        const timestampSeconds = Number(timestamp);
        if (
          accountId === undefined ||
          messageId === undefined ||
          timestamp === undefined ||
          !Number.isSafeInteger(timestampSeconds) ||
          timestampSeconds <= 0 ||
          (status !== "sent" &&
            status !== "delivered" &&
            status !== "read" &&
            status !== "failed")
        )
          continue;
        const firstError = record(array(statusRecord?.errors)[0]);
        const rawErrorCode = firstError?.code;
        const errorCode =
          typeof rawErrorCode === "number" || typeof rawErrorCode === "string"
            ? String(rawErrorCode)
            : undefined;
        results.push({
          providerAccountId: accountId,
          providerMessageId: messageId,
          providerEventId: `${entryId}:${messageId}:${status}:${timestamp}`,
          status,
          occurredAt: new Date(timestampSeconds * 1000).toISOString(),
          ...(errorCode === undefined ? {} : { errorCode }),
        });
      }
    }
  }
  return results;
}
