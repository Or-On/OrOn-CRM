import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { runWorker } from "../src/worker.js";

describe("messaging worker lifecycle", () => {
  it("drains the in-flight effect before closing on a stop signal", async () => {
    let stop!: (value: string) => void;
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const closeDatabase = vi.fn(() => Promise.resolve());
    const processAvailable = vi.fn(async () => {
      entered();
      await pending;
      return 1;
    });
    const running = runWorker(
      {
        closeDatabase,
        processAvailable,
        isDatabaseReady: () => Promise.resolve(true),
        logger: pino({ enabled: false }),
      },
      new Promise<string>((resolve) => {
        stop = resolve;
      }),
    );
    await started;
    stop("SIGTERM");
    await Promise.resolve();
    expect(closeDatabase).not.toHaveBeenCalled();
    finish();
    await running;
    expect(processAvailable).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });
  it("rejects startup when PostgreSQL is unavailable", async () => {
    await expect(
      runWorker(
        {
          closeDatabase: vi.fn(() => Promise.resolve()),
          isDatabaseReady: () => Promise.resolve(false),
          logger: pino({ enabled: false }),
        },
        Promise.resolve("test-stop"),
      ),
    ).rejects.toThrow("PostgreSQL is unavailable");
  });

  it("reports health only after a successful database-backed poll", async () => {
    let stop!: (value: string) => void;
    const processAvailable = vi.fn(() => Promise.resolve(0));
    const recordSuccessfulPoll = vi.fn(() => Promise.resolve());
    await runWorker(
      {
        closeDatabase: vi.fn(() => Promise.resolve()),
        isDatabaseReady: () => Promise.resolve(true),
        logger: pino({ enabled: false }),
        processAvailable,
        recordSuccessfulPoll,
        wait: () => {
          stop("test-stop");
          return Promise.resolve();
        },
      },
      new Promise<string>((resolve) => {
        stop = resolve;
      }),
    );

    expect(processAvailable).toHaveBeenCalledOnce();
    expect(recordSuccessfulPoll).toHaveBeenCalledOnce();
    expect(processAvailable.mock.invocationCallOrder[0]).toBeLessThan(
      recordSuccessfulPoll.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("never reports health when polling fails", async () => {
    const closeDatabase = vi.fn(() => Promise.resolve());
    const recordSuccessfulPoll = vi.fn(() => Promise.resolve());
    await expect(
      runWorker(
        {
          closeDatabase,
          isDatabaseReady: () => Promise.resolve(true),
          logger: pino({ enabled: false }),
          processAvailable: () => Promise.reject(new Error("poll failed")),
          recordSuccessfulPoll,
        },
        new Promise<string>(() => undefined),
      ),
    ).rejects.toThrow("poll failed");

    expect(recordSuccessfulPoll).not.toHaveBeenCalled();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it("closes its database dependency during graceful shutdown", async () => {
    const closeDatabase = vi.fn(() => Promise.resolve());
    await runWorker(
      {
        closeDatabase,
        isDatabaseReady: () => Promise.resolve(true),
        logger: pino({ enabled: false }),
      },
      Promise.resolve("test-stop"),
    );

    expect(closeDatabase).toHaveBeenCalledOnce();
  });
});
