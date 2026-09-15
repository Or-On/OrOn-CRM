import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { hasFreshWorkerHealth, WorkerHealthSignal } from "../src/health.js";
import { messagingWorkerIsHealthy } from "../src/healthcheck.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function healthPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "oron-worker-health-"));
  cleanup.push(directory);
  return join(directory, "health.json");
}

describe("messaging worker health signal", () => {
  it("atomically records and clears a successful poll", async () => {
    const path = await healthPath();
    let now = 1_000;
    const signal = new WorkerHealthSignal(path, () => now);

    await signal.recordSuccessfulPoll();
    now = 1_050;
    await signal.recordSuccessfulPoll();

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      lastSuccessfulPollMs: 1_050,
    });
    expect(await hasFreshWorkerHealth(path, () => 1_100, 100)).toBe(true);

    await signal.clear();
    await signal.clear();
    expect(await hasFreshWorkerHealth(path, () => 1_100, 100)).toBe(false);
  });

  it("rejects missing, malformed, stale, and future heartbeats", async () => {
    const path = await healthPath();
    expect(await hasFreshWorkerHealth(path, () => 1_000, 100)).toBe(false);

    await writeFile(path, "not-json");
    expect(await hasFreshWorkerHealth(path, () => 1_000, 100)).toBe(false);

    await writeFile(
      path,
      JSON.stringify({ version: 1, lastSuccessfulPollMs: 899 }),
    );
    expect(await hasFreshWorkerHealth(path, () => 1_000, 100)).toBe(false);

    await writeFile(
      path,
      JSON.stringify({ version: 1, lastSuccessfulPollMs: 1_001 }),
    );
    expect(await hasFreshWorkerHealth(path, () => 1_000, 100)).toBe(false);
  });
});

describe("messaging worker healthcheck", () => {
  it("requires both a fresh worker poll and a live database", async () => {
    const heartbeatReady = vi.fn(() => Promise.resolve(true));
    const databaseReady = vi.fn(() => Promise.resolve(true));

    await expect(
      messagingWorkerIsHealthy(
        { MESSAGING_DATABASE_URL: "postgresql://fixture.invalid/database" },
        { heartbeatReady, databaseReady },
      ),
    ).resolves.toBe(true);
    expect(databaseReady).toHaveBeenCalledWith(
      "postgresql://fixture.invalid/database",
    );
  });

  it("does not probe the database without a configured URL or fresh poll", async () => {
    const databaseReady = vi.fn(() => Promise.resolve(true));

    await expect(
      messagingWorkerIsHealthy(
        {},
        { heartbeatReady: vi.fn(() => Promise.resolve(true)), databaseReady },
      ),
    ).resolves.toBe(false);
    await expect(
      messagingWorkerIsHealthy(
        { MESSAGING_DATABASE_URL: "postgresql://fixture.invalid/database" },
        { heartbeatReady: vi.fn(() => Promise.resolve(false)), databaseReady },
      ),
    ).resolves.toBe(false);
    expect(databaseReady).not.toHaveBeenCalled();
  });

  it("reports an unavailable database as unhealthy", async () => {
    await expect(
      messagingWorkerIsHealthy(
        { MESSAGING_DATABASE_URL: "postgresql://fixture.invalid/database" },
        {
          heartbeatReady: vi.fn(() => Promise.resolve(true)),
          databaseReady: vi.fn(() => Promise.resolve(false)),
        },
      ),
    ).resolves.toBe(false);
  });
});
