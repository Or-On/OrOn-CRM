import { describe, expect, it, vi } from "vitest";

import { ControlApiClient } from "../src/index.js";

describe("ControlApiClient", () => {
  it("uses the generated health route and preserves readiness failure payloads", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        Response.json(
          {
            status: "not_ready",
            service: "control-api",
            dependencies: { postgres: "unavailable" },
          },
          { status: 503 },
        ),
      ),
    );
    const client = new ControlApiClient("http://control-api:8000", fetcher);

    const result = await client.getReadiness();

    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://control-api:8000/health/ready"),
    );
    expect(result.status).toBe(503);
    expect(result.ok).toBe(false);
    expect(result.data.dependencies.postgres).toBe("unavailable");
  });
});
