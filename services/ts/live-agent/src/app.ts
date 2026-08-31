import { Hono } from "hono";

export interface LiveAgentDependencies {
  readonly isDatabaseReady: () => Promise<boolean>;
}

export function createLiveAgentApp(dependencies: LiveAgentDependencies): Hono {
  const app = new Hono();

  app.get("/health/live", (context) =>
    context.json({
      status: "alive",
      service: "live-agent",
      version: "0.1.0",
    } as const),
  );

  app.get("/health/ready", async (context) => {
    const ready = await dependencies.isDatabaseReady();
    return context.json(
      {
        status: ready ? "ready" : "not_ready",
        service: "live-agent",
        dependencies: { postgres: ready ? "ready" : "unavailable" },
      } as const,
      ready ? 200 : 503,
    );
  });

  return app;
}
