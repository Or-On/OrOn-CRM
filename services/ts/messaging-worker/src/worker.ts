import type { Logger } from "pino";

export interface WorkerDependencies {
  readonly closeDatabase: () => Promise<void>;
  readonly isDatabaseReady: () => Promise<boolean>;
  readonly logger: Logger;
  readonly recordSuccessfulPoll?: () => Promise<void>;
  readonly processAvailable?: () => Promise<number>;
  readonly wait?: (milliseconds: number) => Promise<void>;
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
    let signal: string | undefined;
    let readyLogged = false;
    const stopped = stop.then((value) => {
      signal = value;
    });
    const stopping = () => signal !== undefined;
    // Drain the bounded current action before closing its persistence pool.
    // Promise.race never cancelled provider traffic and used to lose receipts.
    await Promise.resolve();
    while (!stopping()) {
      const processed = await (dependencies.processAvailable?.() ??
        Promise.resolve(0));
      await dependencies.recordSuccessfulPoll?.();
      if (!readyLogged) {
        dependencies.logger.info({ messagesSent: 0 }, "worker_ready");
        readyLogged = true;
      }
      if (stopping()) break;
      if (processed > 0) {
        dependencies.logger.info({ processed }, "worker_batch_processed");
        continue;
      }
      const idle =
        dependencies.wait?.(1000) ??
        new Promise<void>((resolve) => setTimeout(resolve, 1000));
      await Promise.race([stopped, idle]);
    }
    dependencies.logger.info({ signal }, "worker_stopping");
  } finally {
    await dependencies.closeDatabase();
  }
}
