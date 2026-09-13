import { once } from "node:events";

import { loadConfig } from "@or-on/config";
import { createLogger } from "@or-on/observability";
import { randomUUID } from "node:crypto";

import { createMessagingStore } from "./database.js";
import { runWorker } from "./worker.js";
import {
  MetaWhatsAppProvider,
  SimulatorWhatsAppProvider,
} from "./providers.js";
import { OpenAiCompatibleChatProvider } from "./ai-provider.js";
import { DispatcherAutomaticCallProvider } from "./call-provider.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env, {
    requireMessagingDatabase: true,
    requireWhatsApp: true,
    service: "messaging-worker",
  });
  if (config.messagingDatabaseUrl === undefined) {
    throw new Error("messaging-worker requires MESSAGING_DATABASE_URL");
  }
  const logger = createLogger({
    service: config.service,
    environment: config.environment,
    level: config.logLevel,
  });
  const store = createMessagingStore(
    config.messagingDatabaseUrl,
    `messaging-${randomUUID()}`,
    {
      simulator: new SimulatorWhatsAppProvider(),
      meta: new MetaWhatsAppProvider({
        enabled: config.enableRealWhatsApp,
        accessToken: config.secrets.whatsappAccessToken,
        graphApiVersion: config.whatsApp.graphApiVersion,
        phoneNumberId: config.whatsApp.phoneNumberId,
      }),
    },
    (failure) => logger.warn({ ...failure }, "whatsapp_outbound_failed"),
    {
      simulatorEnabled: config.environment === "development",
      realWhatsAppEnabled: config.enableRealWhatsApp,
      automaticCallsEnabled: config.enableWhatsAppAutoCalls,
      automaticCallProvider: new DispatcherAutomaticCallProvider({
        dispatcherUrl: config.dispatcherUrl,
        enabled:
          config.enableWhatsAppAutoCalls &&
          config.enableRealTelephony &&
          config.enableRealVoiceProviders,
        serviceSecret: config.secrets.authServiceSecret,
      }),
      ...(config.enableWhatsAppAi &&
      config.llm.provider === "openai-compat" &&
      config.secrets.llmApiKey &&
      config.llm.baseUrl &&
      config.llm.model
        ? {
            aiProvider: new OpenAiCompatibleChatProvider({
              apiKey: config.secrets.llmApiKey,
              baseUrl: config.llm.baseUrl,
              model: config.llm.model,
            }),
          }
        : {}),
    },
  );
  const abortController = new AbortController();
  const stop = Promise.race([
    once(process, "SIGINT", { signal: abortController.signal }).then(
      () => "SIGINT",
    ),
    once(process, "SIGTERM", { signal: abortController.signal }).then(
      () => "SIGTERM",
    ),
  ]).finally(() => abortController.abort());

  await runWorker(
    {
      closeDatabase: () => store.close(),
      isDatabaseReady: () => store.isReady(),
      logger,
      processAvailable: () => store.processAvailable(),
    },
    stop,
  );
}

main().catch((error: unknown) => {
  const reason =
    error instanceof Error ? error.message : "unknown startup error";
  process.stderr.write(`messaging-worker failed: ${reason}\n`);
  process.exitCode = 1;
});
