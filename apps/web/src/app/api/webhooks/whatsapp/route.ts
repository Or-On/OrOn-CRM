import { NextResponse } from "next/server";

import {
  InvalidWhatsAppPayloadError,
  InvalidWhatsAppSignatureError,
  acceptWhatsAppWebhook,
} from "@or-on/crm";
import { loadConfig } from "@or-on/config";

export async function POST(request: Request) {
  const config = loadConfig(process.env, {
    requireDatabase: true,
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
    const rawBody = new Uint8Array(await request.arrayBuffer());
    const accepted = await acceptWhatsAppWebhook(
      config.databaseUrl,
      rawBody,
      request.headers.get("x-hub-signature-256"),
      config.secrets.whatsappAppSecret,
    );
    return NextResponse.json({ accepted: accepted.envelopes }, { status: 200 });
  } catch (error) {
    if (error instanceof InvalidWhatsAppSignatureError) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    if (error instanceof InvalidWhatsAppPayloadError) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }
    console.error("WhatsApp webhook persistence failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Webhook unavailable" }, { status: 503 });
  }
}
