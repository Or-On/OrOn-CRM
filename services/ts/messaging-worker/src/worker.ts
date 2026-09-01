import type { Logger } from "pino";

export interface WorkerDependencies {
  readonly closeDatabase: () => Promise<void>;
  readonly isDatabaseReady: () => Promise<boolean>;
  readonly logger: Logger;
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
    dependencies.logger.info(
      { whatsappEnabled: false, messagesSent: 0 },
      "worker_ready",
    );
    let signal: string;
    for (;;) {
      const outcome = await Promise.race([
        stop.then((value) => ({ kind: "stop" as const, value })),
        (dependencies.processAvailable?.() ?? Promise.resolve(0)).then(
          (processed) => ({ kind: "processed" as const, processed }),
        ),
      ]);
      if (outcome.kind === "stop") {
        signal = outcome.value;
        break;
      }
      if (outcome.processed > 0) {
        dependencies.logger.info(
          { processed: outcome.processed },
          "worker_batch_processed",
        );
        continue;
      }
      const idle =
        dependencies.wait?.(1000) ??
        new Promise<void>((resolve) => setTimeout(resolve, 1000));
      const idleOutcome = await Promise.race([
        stop.then((value) => ({ kind: "stop" as const, value })),
        idle.then(() => ({ kind: "idle" as const })),
      ]);
      if (idleOutcome.kind === "stop") {
        signal = idleOutcome.value;
        break;
      }
    }
    dependencies.logger.info({ signal }, "worker_stopping");
  } finally {
    await dependencies.closeDatabase();
  }
}
