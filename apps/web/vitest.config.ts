import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    // The complete jsdom-heavy suite runs many files in parallel. Keep the
    // per-test budget above the observed full-suite contention without making
    // focused failures wait indefinitely.
    testTimeout: 30_000,
  },
});
