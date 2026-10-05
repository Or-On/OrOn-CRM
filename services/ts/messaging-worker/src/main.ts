import { once } from "node:events";
import { resolve } from "node:path";
import { createFilesystemAccountingSpool } from "./model-accounting-spool.js";
import { SonioxAsyncAudioTranscriber } from "./audio-transcription.js";

import { loadConfig } from "@or-on/config";
import {
  privateObjectStorageOptionsFromEnvironment,
  protectedFieldKeysFromEnvironment,
} from "@or-on/crm";
import { createLogger } from "@or-on/observability";
import { randomUUID } from "node:crypto";

import { createMessagingStore } from "./database.js";
import { runWorker } from "./worker.js";
import { createJobWakeup } from "./job-wakeup.js";
import {
  channelCredentialKeys,
  createChannelCredentialResolver,
} from "./channel-credentials.js";
import {
  RoutedMetaWhatsAppProvider,
  SimulatorWhatsAppProvider,
} from "./providers.js";
import { OpenAiCompatibleChatProvider } from "./ai-provider.js";
import {
  createModelCredentialResolver,
  modelCredentialKeys,
} from "./model-credentials.js";
import { ControlApiArtifactVerifier } from "./artifact-verifier.js";
import { OpenAiCompatiblePostCallProvider } from "./post-call-provider.js";
import { DispatcherAutomaticCallProvider } from "./call-provider.js";
import { OpenAiCompatibleFieldServiceProvider } from "./field-service-provider.js";
import { WorkerHealthSignal } from "./health.js";

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
  const llmOptions =
    config.enableWhatsAppAi &&
    config.llm.provider === "openai-compat" &&
    config.secrets.llmApiKey &&
    config.llm.baseUrl &&
    config.llm.model
      ? {
          apiKey: config.secrets.llmApiKey,
          baseUrl: config.llm.baseUrl,
          model: config.llm.model,
        }
      : undefined;
  const credentialKeys = channelCredentialKeys(process.env);
  const modelKeys = modelCredentialKeys(process.env);
  const resolveSealedCredential =
    modelKeys.size === 0 ? undefined : createModelCredentialResolver(modelKeys);
  const resolveChannelCredential =
    credentialKeys.size === 0
      ? undefined
      : createChannelCredentialResolver(credentialKeys);
  const protectedFieldKeys =
    process.env.FIELD_CIPHER_LOCAL_KEY && process.env.BLIND_INDEX_KEY
      ? protectedFieldKeysFromEnvironment(process.env)
      : undefined;
  const privateObjectStorage = privateObjectStorageOptionsFromEnvironment(
    process.env,
  );
  if (
    config.audioTranscription.enabled &&
    (!config.secrets.sonioxApiKey || !config.audioTranscription.model)
  )
    throw new Error(
      "Enabled audio transcription requires explicit provider configuration",
    );
  // Accounting recovery must use an explicitly configured persistent volume.
  // A process-relative default would silently lose billed attempts on replacement.
  const accountingRoot = privateObjectStorage.localRoot?.trim();
  if (llmOptions !== undefined && !accountingRoot)
    throw new Error(
      "LLM accounting requires an explicit private object storage root",
    );
  const modelAccountingSpool =
    llmOptions === undefined || accountingRoot === undefined
      ? undefined
      : await createFilesystemAccountingSpool(
          resolve(accountingRoot, "model-accounting"),
        );
  const store = createMessagingStore(
    config.messagingDatabaseUrl,
    `messaging-${randomUUID()}`,
    {
      simulator: new SimulatorWhatsAppProvider(),
      meta: new RoutedMetaWhatsAppProvider([
        ...(config.whatsApp.phoneNumberId === undefined
          ? []
          : [
              {
                enabled: config.enableRealWhatsApp,
                accessToken: config.secrets.whatsappAccessToken,
                graphApiVersion: config.whatsApp.graphApiVersion,
                phoneNumberId: config.whatsApp.phoneNumberId,
              },
            ]),
        ...config.whatsAppAdditionalAccounts.map((account) => ({
          enabled: config.enableRealWhatsApp,
          accessToken: account.accessToken,
          graphApiVersion: account.graphApiVersion,
          phoneNumberId: account.phoneNumberId,
        })),
      ]),
    },
    (failure) => logger.warn({ ...failure }, "whatsapp_outbound_failed"),
    {
      simulatorEnabled: config.environment === "development",
      realWhatsAppEnabled: config.enableRealWhatsApp,
      ...(config.publicSiteUrl === undefined
        ? {}
        : { publicSiteUrl: config.publicSiteUrl }),
      ...(resolveChannelCredential === undefined
        ? {}
        : { resolveChannelCredential }),
      // Explicit bindings require tenant credential and atomic quota adapters.
      // Without those adapters resolution closes; deployment keys are never used.
      modelRouting: {
        ...(resolveSealedCredential === undefined
          ? {}
          : { resolveSealedCredential }),
        createProvider: (route) =>
          new OpenAiCompatibleChatProvider({
            apiKey: route.credential.apiKey,
            baseUrl: route.baseUrl,
            model: route.model,
            ...route.settings,
          }),
      },
      automaticCallsEnabled: config.enableWhatsAppAutoCalls,
      privateObjectStorage,
      ...(config.audioTranscription.enabled &&
      config.secrets.sonioxApiKey !== undefined &&
      config.audioTranscription.model !== undefined
        ? {
            audioTranscriber: new SonioxAsyncAudioTranscriber({
              apiKey: config.secrets.sonioxApiKey,
              model: config.audioTranscription.model,
            }),
          }
        : {}),
      ...(modelAccountingSpool === undefined ? {} : { modelAccountingSpool }),
      automaticCallProvider: new DispatcherAutomaticCallProvider({
        dispatcherUrl: config.dispatcherUrl,
        enabled:
          config.enableWhatsAppAutoCalls &&
          config.enableRealTelephony &&
          config.enableRealVoiceProviders,
        serviceSecret: config.secrets.authServiceSecret,
      }),
      // Reads a finished call's artifacts through the service that owns them,
      // so a `ready` recording on a ticket means the playback route can serve
      // those bytes rather than that a URI was written.
      artifactVerifier: new ControlApiArtifactVerifier({
        controlApiUrl: config.controlApiUrl,
        serviceSecret: config.secrets.authServiceSecret,
      }),
      ...(llmOptions === undefined
        ? {}
        : {
            aiProvider: new OpenAiCompatibleChatProvider({
              ...llmOptions,
              ...(config.llm.fallbackModel === undefined
                ? {}
                : { fallbackModel: config.llm.fallbackModel }),
            }),
            fieldServiceProvider: new OpenAiCompatibleFieldServiceProvider(
              llmOptions,
            ),
            postCallProvider: new OpenAiCompatiblePostCallProvider(llmOptions),
            postCallModel: llmOptions.model,
          }),
      ...(protectedFieldKeys === undefined
        ? {}
        : {
            protectedFieldKeys,
          }),
    },
  );
  const abortController = new AbortController();
  const health = new WorkerHealthSignal();
  await health.clear();
  const stop = Promise.race([
    once(process, "SIGINT", { signal: abortController.signal }).then(
      () => "SIGINT",
    ),
    once(process, "SIGTERM", { signal: abortController.signal }).then(
      () => "SIGTERM",
    ),
  ]).finally(() => abortController.abort());

  try {
    const wakeup = createJobWakeup(config.messagingDatabaseUrl);
    await runWorker(
      {
        closeDatabase: async () => {
          try {
            await wakeup.close();
          } finally {
            await store.close();
          }
        },
        isDatabaseReady: () => store.isReady(),
        logger,
        processAvailable: () => store.processAvailable(),
        recordSuccessfulPoll: () => health.recordSuccessfulPoll(),
        wait: (milliseconds) => wakeup.wait(milliseconds),
      },
      stop,
    );
  } finally {
    await health.clear();
  }
}

main().catch((error: unknown) => {
  const reason =
    error instanceof Error ? error.message : "unknown startup error";
  process.stderr.write(`messaging-worker failed: ${reason}\n`);
  process.exitCode = 1;
});
