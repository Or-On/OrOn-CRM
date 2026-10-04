import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Build output is not another suite: it can contain stale emitted tests.
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // The legacy diagnostics and worker suites share the supplied source DB
    // and claim globally across its tenants. Concurrent files steal fixtures.
    fileParallelism: false,
  },
});
