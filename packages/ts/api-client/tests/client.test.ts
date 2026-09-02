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

  it("uses the generated authenticated voice-session route", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(Response.json({ items: [] }, { status: 200 })),
    );
    const client = new ControlApiClient("http://control-api:8000", fetcher);

    const result = await client.listVoiceSessions();

    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://control-api:8000/api/v1/voice/sessions"),
    );
    expect(result.status).toBe(200);
    expect(result.data.items).toEqual([]);
  });

  it("serializes the simulator command through the generated client", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        Response.json(
          {
            created: true,
            event_types: ["voice.call.ended.v1"],
            session: { session_id: "simulated-session" },
          },
          { status: 200 },
        ),
      ),
    );
    const client = new ControlApiClient("http://control-api:8000", fetcher);

    const result = await client.simulateVoiceCall({
      contact_id: "30000000-0000-4000-8000-000000000001",
      idempotency_key: "phase5-client-test",
      mode: "simulator",
    });

    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://control-api:8000/api/v1/voice/simulated-calls"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contact_id: "30000000-0000-4000-8000-000000000001",
          idempotency_key: "phase5-client-test",
          mode: "simulator",
        }),
      },
    );
    expect(result.data.created).toBe(true);
  });
});
