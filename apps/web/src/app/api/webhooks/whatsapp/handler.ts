import { NextResponse } from "next/server";

import {
  InvalidWhatsAppPayloadError,
  InvalidWhatsAppSignatureError,
  acceptWhatsAppWebhook,
} from "@or-on/crm";

const MAXIMUM_WEBHOOK_BYTES = 2 * 1024 * 1024;
class InvalidWebhookBodyError extends Error {}

async function readWebhookBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^[0-9]+$/u.test(declared) || Number(declared) > MAXIMUM_WEBHOOK_BYTES)
  )
    throw new RangeError("Webhook payload is too large");
  const reader = request.body?.getReader();
  if (reader === undefined)
    throw new InvalidWebhookBodyError("Webhook body is required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAXIMUM_WEBHOOK_BYTES) {
        await reader.cancel();
        throw new RangeError("Webhook payload is too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

export function verifyWhatsAppWebhook(
  request: Request,
  enabled: boolean,
  verifyToken: string | undefined,
) {
  if (!enabled || verifyToken === undefined)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode !== "subscribe" || token !== verifyToken || challenge === null)
    return NextResponse.json({ error: "Verification failed" }, { status: 403 });
  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function receiveWhatsAppWebhook(
  request: Request,
  account: {
    readonly enabled: boolean;
    readonly databaseUrl: string | undefined;
    readonly appSecret: string | undefined;
    readonly phoneNumberId?: string | undefined;
  },
) {
  if (!account.enabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (account.databaseUrl === undefined || account.appSecret === undefined) {
    return NextResponse.json(
      { error: "WhatsApp webhook is not configured" },
      { status: 503 },
    );
  }

  try {
    const rawBody = await readWebhookBody(request);
    const accepted = await acceptWhatsAppWebhook(
      account.databaseUrl,
      rawBody,
      request.headers.get("x-hub-signature-256"),
      account.appSecret,
      account.phoneNumberId,
    );
    return NextResponse.json({ accepted: accepted.envelopes }, { status: 200 });
  } catch (error) {
    if (error instanceof RangeError)
      return NextResponse.json(
        { error: "Webhook payload is too large" },
        { status: 413 },
      );
    if (error instanceof InvalidWhatsAppSignatureError) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    if (error instanceof InvalidWhatsAppPayloadError) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }
    if (error instanceof InvalidWebhookBodyError)
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    console.error("WhatsApp webhook persistence failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Webhook unavailable" }, { status: 503 });
  }
}
