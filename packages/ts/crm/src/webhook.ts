import { createHmac, timingSafeEqual } from "node:crypto";

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
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
  readonly contentType?:
    | "text"
    | "image"
    | "document"
    | "location"
    | "audio"
    | "video"
    | "interactive"
    | "event";
  /** Provider content remains untrusted; it never determines tenant authority. */
  readonly providerMessageType?: string;
  readonly interaction?: { readonly id: string; readonly title: string };
  readonly reaction?: { readonly messageId: string; readonly emoji: string };
  readonly text: string;
  /** The provider message this one replies to (WhatsApp `context.id`). */
  readonly replyToProviderMessageId?: string;
  readonly media?: {
    readonly id: string;
    readonly mimeType?: string;
    readonly sha256?: string;
    readonly fileName?: string;
    readonly caption?: string;
  };
  readonly location?: {
    readonly latitude: number;
    readonly longitude: number;
    readonly name?: string;
    readonly address?: string;
  };
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
    boundedString(envelope.providerAccountId, 500) === undefined ||
    typeof envelope.providerEventId !== "string" ||
    boundedString(envelope.providerEventId, 2_100) === undefined ||
    typeof envelope.providerMessageId !== "string" ||
    boundedString(envelope.providerMessageId, 1_000) === undefined ||
    typeof envelope.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(envelope.occurredAt)) ||
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
  const contentType = envelope?.contentType ?? "text";
  if (
    typeof envelope?.providerAccountId !== "string" ||
    typeof envelope.providerEventId !== "string" ||
    typeof envelope.providerMessageId !== "string" ||
    typeof envelope.from !== "string" ||
    typeof envelope.profileName !== "string" ||
    typeof envelope.text !== "string" ||
    (contentType !== "text" &&
      contentType !== "image" &&
      contentType !== "document" &&
      contentType !== "location" &&
      contentType !== "audio" &&
      contentType !== "video" &&
      contentType !== "interactive" &&
      contentType !== "event")
  ) {
    return undefined;
  }
  const mediaRecord = record(envelope.media);
  const locationRecord = record(envelope.location);
  const media =
    contentType === "image" ||
    contentType === "document" ||
    contentType === "audio" ||
    contentType === "video"
      ? storedMedia(mediaRecord)
      : undefined;
  const location =
    contentType === "location" ? storedLocation(locationRecord) : undefined;
  if (
    ((contentType === "image" ||
      contentType === "document" ||
      contentType === "audio" ||
      contentType === "video") &&
      media === undefined) ||
    (contentType === "location" && location === undefined) ||
    envelope.text.length > 65_536 ||
    (contentType === "text" && envelope.text.trim() === "") ||
    boundedString(envelope.providerAccountId, 500) === undefined ||
    boundedString(envelope.providerEventId, 2_001) === undefined ||
    boundedString(envelope.providerMessageId, 1_000) === undefined ||
    !/^\+[1-9]\d{6,14}$/u.test(envelope.from) ||
    envelope.profileName.length > 500
  )
    return undefined;
  const replyTo = boundedString(envelope.replyToProviderMessageId, 1_000);
  const providerMessageType = boundedString(envelope.providerMessageType, 100);
  const interactionRecord = record(envelope.interaction);
  const interactionId = boundedString(interactionRecord?.id, 500);
  const interactionTitle = boundedString(interactionRecord?.title, 1_024);
  const reactionRecord = record(envelope.reaction);
  const reactionMessage = boundedString(reactionRecord?.messageId, 1_000);
  const reactionEmoji =
    typeof reactionRecord?.emoji === "string" &&
    reactionRecord.emoji.length <= 64
      ? reactionRecord.emoji
      : undefined;
  if (
    contentType === "interactive" &&
    (interactionId === undefined || interactionTitle === undefined)
  )
    return undefined;
  if (
    providerMessageType === "reaction" &&
    (reactionMessage === undefined || reactionEmoji === undefined)
  )
    return undefined;
  return {
    ...(typeof envelope.occurredAt === "string" &&
    Number.isFinite(Date.parse(envelope.occurredAt))
      ? { occurredAt: envelope.occurredAt }
      : {}),
    ...(replyTo === undefined ? {} : { replyToProviderMessageId: replyTo }),
    providerAccountId: envelope.providerAccountId,
    providerEventId: envelope.providerEventId,
    providerMessageId: envelope.providerMessageId,
    from: envelope.from,
    profileName: envelope.profileName,
    contentType,
    text: envelope.text,
    ...(providerMessageType === undefined ? {} : { providerMessageType }),
    ...(interactionId === undefined || interactionTitle === undefined
      ? {}
      : { interaction: { id: interactionId, title: interactionTitle } }),
    ...(reactionMessage === undefined || reactionEmoji === undefined
      ? {}
      : { reaction: { messageId: reactionMessage, emoji: reactionEmoji } }),
    ...(media === undefined ? {} : { media }),
    ...(location === undefined ? {} : { location }),
  };
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized !== "" && normalized.length <= maximum
    ? normalized
    : undefined;
}

function storedMedia(
  value: Readonly<Record<string, unknown>> | undefined,
): WhatsAppInboundEnvelope["media"] {
  const id = boundedString(value?.id, 500);
  if (id === undefined) return undefined;
  const mimeType = boundedString(value?.mimeType, 200);
  const sha256 = boundedString(value?.sha256, 200);
  const fileName = boundedString(value?.fileName, 500);
  const caption = boundedString(value?.caption, 4_096);
  return {
    id,
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(fileName === undefined ? {} : { fileName }),
    ...(caption === undefined ? {} : { caption }),
  };
}

function storedLocation(
  value: Readonly<Record<string, unknown>> | undefined,
): WhatsAppInboundEnvelope["location"] {
  const latitude = value?.latitude;
  const longitude = value?.longitude;
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  )
    return undefined;
  const name = boundedString(value?.name, 500);
  const address = boundedString(value?.address, 1_000);
  return {
    latitude,
    longitude,
    ...(name === undefined ? {} : { name }),
    ...(address === undefined ? {} : { address }),
  };
}

function messageOccurredAt(
  message: Readonly<Record<string, unknown>>,
): string | undefined {
  const timestamp =
    typeof message.timestamp === "string" ? Number(message.timestamp) : NaN;
  return Number.isSafeInteger(timestamp) &&
    timestamp > 0 &&
    timestamp < 8_640_000_000_000
    ? new Date(timestamp * 1000).toISOString()
    : undefined;
}

export function parseWhatsAppMessageEnvelopes(
  payload: unknown,
): readonly WhatsAppInboundEnvelope[] {
  const root = record(payload);
  if (root === undefined) return [];
  const results: WhatsAppInboundEnvelope[] = [];

  for (const entryValue of array(root.entry)) {
    const entry = record(entryValue);
    if (entry === undefined) continue;
    const entryId = boundedString(entry.id, 1_000) ?? "unknown";

    for (const changeValue of array(entry.changes)) {
      const value = record(record(changeValue)?.value);
      const metadata = record(value?.metadata);
      const accountId = boundedString(metadata?.phone_number_id, 500);
      if (accountId === undefined) continue;
      const contacts = array(value?.contacts);
      const contact = record(contacts[0]);
      const profile = record(contact?.profile);

      for (const messageValue of array(value?.messages)) {
        const message = record(messageValue);
        if (message === undefined) continue;
        const id = boundedString(message.id, 1_000);
        const rawFrom = boundedString(message.from, 100);
        if (id === undefined || rawFrom === undefined) continue;
        const from = `+${rawFrom.replace(/^\+/u, "")}`;
        if (!/^\+[1-9]\d{6,14}$/u.test(from)) continue;
        // A batch may contain several senders; never borrow the first name.
        const matchingContact = contacts
          .map(record)
          .find(
            (candidate) => candidate?.wa_id === rawFrom.replace(/^\+/u, ""),
          );
        const profileName =
          boundedString(record(matchingContact?.profile)?.name, 500) ??
          (contacts.length === 1 && contact?.wa_id === undefined
            ? boundedString(profile?.name, 500)
            : undefined) ??
          from;
        const occurredAt = messageOccurredAt(message);
        const replyTo = boundedString(record(message.context)?.id, 1_000);
        const base = {
          ...(occurredAt === undefined ? {} : { occurredAt }),
          ...(replyTo === undefined
            ? {}
            : { replyToProviderMessageId: replyTo }),
          providerAccountId: accountId,
          providerEventId: `${entryId}:${id}`,
          providerMessageId: id,
          from,
          profileName,
        };
        const type =
          message.type ??
          (record(message.text) !== undefined ? "text" : undefined);
        if (type === "text") {
          const body = boundedString(record(message.text)?.body, 65_536);
          if (body !== undefined)
            results.push({ ...base, contentType: "text", text: body });
          continue;
        }
        if (
          type === "image" ||
          type === "document" ||
          type === "audio" ||
          type === "video" ||
          type === "sticker"
        ) {
          const providerMedia = record(message[type]);
          const media = storedMedia(
            providerMedia === undefined
              ? undefined
              : {
                  id: providerMedia.id,
                  mimeType: providerMedia.mime_type,
                  sha256: providerMedia.sha256,
                  fileName: providerMedia.filename,
                  caption: providerMedia.caption,
                },
          );
          if (media !== undefined)
            results.push({
              ...base,
              contentType: type === "sticker" ? "image" : type,
              ...(type === "sticker" ? { providerMessageType: "sticker" } : {}),
              text:
                type === "audio"
                  ? "[Voice note: transcription pending]"
                  : (media.caption ?? ""),
              media,
            });
          continue;
        }
        if (type === "interactive" || type === "button") {
          const interactive = record(message.interactive);
          const selected =
            type === "button"
              ? record(message.button)
              : interactive?.type === "button_reply"
                ? record(interactive.button_reply)
                : interactive?.type === "list_reply"
                  ? record(interactive.list_reply)
                  : undefined;
          if (
            type === "interactive" &&
            selected === undefined &&
            boundedString(interactive?.type, 100) !== undefined &&
            interactive?.type !== "button_reply" &&
            interactive?.type !== "list_reply"
          ) {
            results.push({
              ...base,
              contentType: "event",
              providerMessageType: "interactive",
              text: "[Unsupported WhatsApp interactive message]",
            });
            continue;
          }
          const selectedId = boundedString(
            type === "button" ? selected?.payload : selected?.id,
            500,
          );
          const title = boundedString(
            type === "button" ? selected?.text : selected?.title,
            1_024,
          );
          if (selectedId !== undefined && title !== undefined)
            results.push({
              ...base,
              contentType: "interactive",
              providerMessageType: type,
              text: title,
              interaction: { id: selectedId, title },
            });
          continue;
        }
        if (type === "reaction") {
          const reaction = record(message.reaction);
          const messageId = boundedString(reaction?.message_id, 1_000);
          const emoji =
            typeof reaction?.emoji === "string" && reaction.emoji.length <= 64
              ? reaction.emoji
              : undefined;
          if (messageId !== undefined && emoji !== undefined)
            results.push({
              ...base,
              contentType: "event",
              providerMessageType: "reaction",
              text:
                emoji === "" ? "[Reaction removed]" : `[Reaction: ${emoji}]`,
              reaction: { messageId, emoji },
            });
          continue;
        }
        if (type === "location") {
          const providerLocation = record(message.location);
          const location = storedLocation(
            providerLocation === undefined
              ? undefined
              : {
                  latitude: providerLocation.latitude,
                  longitude: providerLocation.longitude,
                  name: providerLocation.name,
                  address: providerLocation.address,
                },
          );
          if (location !== undefined)
            results.push({
              ...base,
              contentType: "location",
              text: location.name ?? location.address ?? "",
              location,
            });
          continue;
        }
        const unsupportedType = boundedString(type, 100);
        if (unsupportedType !== undefined)
          results.push({
            ...base,
            contentType: "event",
            providerMessageType: unsupportedType,
            text: `[Unsupported WhatsApp message: ${unsupportedType}]`,
          });
      }
    }
  }
  return results;
}

export function parseWhatsAppTextEnvelopes(
  payload: unknown,
): readonly WhatsAppInboundEnvelope[] {
  return parseWhatsAppMessageEnvelopes(payload).filter(
    (envelope) => (envelope.contentType ?? "text") === "text",
  );
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
      const accountId = boundedString(metadata?.phone_number_id, 500);
      for (const statusValue of array(value?.statuses)) {
        const statusRecord = record(statusValue);
        const messageId = boundedString(statusRecord?.id, 1_000);
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
          timestampSeconds >= 8_640_000_000_000 ||
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
