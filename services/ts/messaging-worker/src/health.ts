import { readFile, rename, unlink, writeFile } from "node:fs/promises";

export const WORKER_HEALTH_FILE = "/tmp/oron-messaging-worker-health.json";
export const WORKER_HEALTH_MAX_AGE_MS = 90_000;

interface WorkerHealthDocument {
  readonly version: 1;
  readonly lastSuccessfulPollMs: number;
}

export class WorkerHealthSignal {
  readonly #path: string;
  readonly #now: () => number;

  public constructor(path = WORKER_HEALTH_FILE, now: () => number = Date.now) {
    this.#path = path;
    this.#now = now;
  }

  public async clear(): Promise<void> {
    await unlink(this.#path).catch((error: unknown) => {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    });
  }

  public async recordSuccessfulPoll(): Promise<void> {
    const document: WorkerHealthDocument = {
      version: 1,
      lastSuccessfulPollMs: this.#now(),
    };
    const temporary = `${this.#path}.${String(process.pid)}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.#path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export async function hasFreshWorkerHealth(
  path = WORKER_HEALTH_FILE,
  now: () => number = Date.now,
  maxAgeMs = WORKER_HEALTH_MAX_AGE_MS,
): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("lastSuccessfulPollMs" in parsed) ||
      typeof parsed.lastSuccessfulPollMs !== "number" ||
      !Number.isSafeInteger(parsed.lastSuccessfulPollMs)
    )
      return false;
    const age = now() - parsed.lastSuccessfulPollMs;
    return age >= 0 && age <= maxAgeMs;
  } catch {
    return false;
  }
}
