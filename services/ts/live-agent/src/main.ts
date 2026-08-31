import { serve } from "@hono/node-server";
import { loadConfig } from "@or-on/config";
import { createLogger } from "@or-on/observability";
import { createPostgresProbe } from "@or-on/platform-integration";

import { createLiveAgentApp } from "./app.js";

const config = loadConfig(process.env, {
  requireDatabase: true,
  service: "live-agent",
});
if (config.databaseUrl === undefined) {
  throw new Error("live-agent requires DATABASE_URL");
}
const logger = createLogger({
  service: config.service,
  environment: config.environment,
  level: config.logLevel,
});
const probe = createPostgresProbe(config.databaseUrl);
const app = createLiveAgentApp({ isDatabaseReady: () => probe.isReady() });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 8787 });

logger.info({ providerActions: "disabled" }, "service_started");

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "service_stopping");
  server.close();
  await probe.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
