import { loadConfig } from "@or-on/config";

import { receiveWhatsAppWebhook, verifyWhatsAppWebhook } from "../handler";

export async function GET(
  request: Request,
  context: RouteContext<"/api/webhooks/whatsapp/[accountKey]">,
) {
  const { accountKey } = await context.params;
  const config = loadConfig(process.env, {
    requireWhatsApp: true,
    service: "web",
  });
  const account = config.whatsAppAdditionalAccounts.find(
    (candidate) => candidate.key === accountKey,
  );
  return verifyWhatsAppWebhook(
    request,
    config.enableRealWhatsApp && account !== undefined,
    account?.webhookVerifyToken,
  );
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/webhooks/whatsapp/[accountKey]">,
) {
  const { accountKey } = await context.params;
  const config = loadConfig(process.env, {
    requireDatabase: true,
    requireWhatsApp: true,
    service: "web",
  });
  const account = config.whatsAppAdditionalAccounts.find(
    (candidate) => candidate.key === accountKey,
  );
  return receiveWhatsAppWebhook(request, {
    enabled: config.enableRealWhatsApp && account !== undefined,
    databaseUrl: config.databaseUrl,
    appSecret: account?.appSecret,
    phoneNumberId: account?.phoneNumberId,
  });
}
