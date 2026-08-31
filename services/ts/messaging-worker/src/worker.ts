import type { Logger } from "pino";

export interface WorkerDependencies {
  readonly closeDatabase: () => Promise<void>;
  readonly isDatabaseReady: () => Promise<boolean>;
  readonly logger: Logger;
}

export async function runWorker(
  dependencies: WorkerDependencies,
  stop: Promise<string>,
): Promise<void> {
  try {
    if (!(await dependencies.isDatabaseReady())) {
      throw new Error(
        "messaging-worker is not ready: PostgreSQL is unavailable",
      );
    }
    dependencies.logger.info(
      { whatsappEnabled: false, messagesSent: 0 },
      "worker_ready",
    );
    const signal = await stop;
    dependencies.logger.info({ signal }, "worker_stopping");
  } finally {
    await dependencies.closeDatabase();
  }
}
