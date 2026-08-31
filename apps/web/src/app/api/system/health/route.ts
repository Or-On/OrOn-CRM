import { ControlApiClient } from "@or-on/api-client";
import { loadConfig } from "@or-on/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = loadConfig(process.env, { service: "web" });
  const client = new ControlApiClient(config.controlApiUrl);
  try {
    const [liveness, readiness] = await Promise.all([
      client.getLiveness(),
      client.getReadiness(),
    ]);
    return Response.json(
      {
        checkedAt: new Date().toISOString(),
        controlApi: { liveness, readiness },
      },
      { status: liveness.ok ? 200 : 503 },
    );
  } catch {
    return Response.json(
      {
        checkedAt: new Date().toISOString(),
        controlApi: null,
        error: "control-api unavailable",
      },
      { status: 503 },
    );
  }
}
