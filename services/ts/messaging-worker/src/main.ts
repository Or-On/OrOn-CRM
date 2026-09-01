import { once } from "node:events";

import { loadConfig } from "@or-on/config";
import { createLogger } from "@or-on/observability";
import { randomUUID } from "node:crypto";

import { createMessagingStore } from "./database.js";
import { runWorker } from "./worker.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env, {
    requireDatabase: true,
    service: "messaging-worker",
  });
  if (config.databaseUrl === undefined) {
    throw new Error("messaging-worker requires DATABASE_URL");
  }
  const store = createMessagingStore(
    config.databaseUrl,
    `messaging-${randomUUID()}`,
  );
  const logger = createLogger({
    service: config.service,
    environment: config.environment,
    level: config.logLevel,
  });
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
