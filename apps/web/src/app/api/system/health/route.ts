import { ControlApiClient } from "@or-on/api-client";
import { loadConfig } from "@or-on/config";
import {
  ForbiddenError,
  requirePublicSession,
  UnauthenticatedError,
} from "../../../../features/auth";

export const dynamic = "force-dynamic";

async function timeProbe<T>(probe: () => Promise<T>) {
  const startedAt = performance.now();
  const result = await probe();
  return {
    result,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

export async function GET() {
  try {
    // Platform health belongs to the workspace, not the technician app.
    await requirePublicSession({ application: "workspace" });
  } catch (error) {
    if (error instanceof ForbiddenError)
      return Response.json({ error: "Forbidden" }, { status: 403 });
    return Response.json(
      {
        error:
          error instanceof UnauthenticatedError
            ? "Unauthenticated"
            : "Health check unavailable",
      },
      { status: error instanceof UnauthenticatedError ? 401 : 503 },
    );
  }
  const config = loadConfig(process.env, { service: "web" });
  const client = new ControlApiClient(config.controlApiUrl, (input, init) =>
    fetch(input, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    }),
  );
  const runtimeGates = {
    whatsappDelivery: config.enableRealWhatsApp,
    whatsappAi: config.enableWhatsAppAi,
    voiceCalling: config.enableRealTelephony && config.enableRealVoiceProviders,
    automaticCallbacks: config.enableWhatsAppAutoCalls,
  };
  try {
    const [livenessProbe, readinessProbe] = await Promise.all([
      timeProbe(() => client.getLiveness()),
      timeProbe(() => client.getReadiness()),
    ]);
    const liveness = livenessProbe.result;
    const readiness = readinessProbe.result;
    const postgresStatus: unknown = readiness.data.dependencies.postgres;
    if (postgresStatus !== "ready" && postgresStatus !== "unavailable")
      throw new TypeError("Invalid readiness observation");
    return Response.json(
      {
        checkedAt: new Date().toISOString(),
        controlApi: {
          liveness: {
            ok: liveness.ok,
            status: liveness.status,
            durationMs: livenessProbe.durationMs,
          },
          readiness: {
            ok: readiness.ok,
            status: readiness.status,
            durationMs: readinessProbe.durationMs,
            data: {
              dependencies: { postgres: postgresStatus },
            },
          },
        },
        runtimeGates,
      },
      { status: liveness.ok ? 200 : 503 },
    );
  } catch {
    return Response.json(
      {
        checkedAt: new Date().toISOString(),
        controlApi: null,
        runtimeGates,
        error: "control-api unavailable",
      },
      { status: 503 },
    );
  }
}
