import { NextResponse } from "next/server";

import {
  InvalidWhatsAppPayloadError,
  InvalidWhatsAppSignatureError,
  acceptWhatsAppWebhook,
} from "@or-on/crm";
import { loadConfig } from "@or-on/config";

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

export function GET(request: Request) {
  const config = loadConfig(process.env, {
    requireWhatsApp: true,
    service: "web",
  });
  if (
    !config.enableRealWhatsApp ||
    config.secrets.whatsappWebhookVerifyToken === undefined
  )
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (
    mode !== "subscribe" ||
    token !== config.secrets.whatsappWebhookVerifyToken ||
    challenge === null
  )
    return NextResponse.json({ error: "Verification failed" }, { status: 403 });
  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function POST(request: Request) {
  const config = loadConfig(process.env, {
    requireDatabase: true,
    requireWhatsApp: true,
    service: "web",
  });
  if (!config.enableRealWhatsApp) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (
    config.databaseUrl === undefined ||
    config.secrets.whatsappAppSecret === undefined
  ) {
    return NextResponse.json(
      { error: "WhatsApp webhook is not configured" },
      { status: 503 },
    );
  }

  try {
    const rawBody = await readWebhookBody(request);
    const accepted = await acceptWhatsAppWebhook(
      config.databaseUrl,
      rawBody,
      request.headers.get("x-hub-signature-256"),
      config.secrets.whatsappAppSecret,
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
