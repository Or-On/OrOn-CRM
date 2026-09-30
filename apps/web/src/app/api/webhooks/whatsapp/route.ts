import { loadConfig } from "@or-on/config";

import { receiveWhatsAppWebhook, verifyWhatsAppWebhook } from "./handler";

export function GET(request: Request) {
  const config = loadConfig(process.env, {
    requireWhatsApp: true,
    service: "web",
  });
  return verifyWhatsAppWebhook(
    request,
    config.enableRealWhatsApp,
    config.secrets.whatsappWebhookVerifyToken,
  );
}

export async function POST(request: Request) {
  const config = loadConfig(process.env, {
    requireDatabase: true,
    requireWhatsApp: true,
    service: "web",
  });
  return receiveWhatsAppWebhook(request, {
    enabled: config.enableRealWhatsApp,
    databaseUrl: config.databaseUrl,
    appSecret: config.secrets.whatsappAppSecret,
  });
}
