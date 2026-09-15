import { pathToFileURL } from "node:url";

import postgres from "postgres";

import { hasFreshWorkerHealth } from "./health.js";

export interface WorkerHealthcheckDependencies {
  readonly databaseReady: (databaseUrl: string) => Promise<boolean>;
  readonly heartbeatReady: () => Promise<boolean>;
}

async function databaseReady(databaseUrl: string): Promise<boolean> {
  const sql = postgres(databaseUrl, {
    connect_timeout: 2,
    idle_timeout: 1,
    max: 1,
    prepare: false,
    connection: { statement_timeout: 2000 },
  });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

const defaultDependencies: WorkerHealthcheckDependencies = {
  databaseReady,
  heartbeatReady: hasFreshWorkerHealth,
};

export async function messagingWorkerIsHealthy(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: WorkerHealthcheckDependencies = defaultDependencies,
): Promise<boolean> {
  const databaseUrl = environment.MESSAGING_DATABASE_URL?.trim();
  if (!databaseUrl || !(await dependencies.heartbeatReady())) return false;
  return dependencies.databaseReady(databaseUrl);
}

async function main(): Promise<void> {
  if (!(await messagingWorkerIsHealthy())) process.exitCode = 1;
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  void main().catch(() => {
    // Keep the probe secret-free: the DSN and driver errors must not reach logs.
    process.exitCode = 1;
  });
}
