import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { runWorker } from "../src/worker.js";

describe("messaging worker lifecycle", () => {
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
