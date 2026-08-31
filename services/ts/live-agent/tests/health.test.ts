import { describe, expect, it } from "vitest";

import { createLiveAgentApp } from "../src/app.js";

describe("live-agent health", () => {
  it("reports process liveness independently", async () => {
    const app = createLiveAgentApp({
      isDatabaseReady: () => Promise.resolve(false),
    });
    const response = await app.request("/health/live");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "alive" });
  });

  it("fails readiness when PostgreSQL is unavailable", async () => {
    const app = createLiveAgentApp({
      isDatabaseReady: () => Promise.resolve(false),
    });
    const response = await app.request("/health/ready");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "not_ready",
      service: "live-agent",
      dependencies: { postgres: "unavailable" },
    });
  });
});
