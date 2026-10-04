import { loadConfig, loadWhatsAppMemoryVerifier } from "@or-on/config";

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
  const memoryVerifier = loadWhatsAppMemoryVerifier(process.env, "web");
  return receiveWhatsAppWebhook(request, {
    enabled: config.enableRealWhatsApp,
    databaseUrl: config.databaseUrl,
    memoryVerifierEnabled: memoryVerifier.enabled,
    memoryVerifierDatabaseUrl: memoryVerifier.databaseUrl,
    appSecret: config.secrets.whatsappAppSecret,
    phoneNumberId: config.whatsApp.phoneNumberId,
    wabaId: config.whatsApp.wabaId,
  });
}
