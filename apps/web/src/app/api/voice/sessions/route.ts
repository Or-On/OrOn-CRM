import { ControlApiClient } from "@or-on/api-client";
import { loadConfig } from "@or-on/config";

import {
  currentRawSession,
  ForbiddenError,
  issueControlApiGrant,
} from "../../../../features/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const resolved = await currentRawSession();
    if (resolved === undefined)
      return Response.json({ error: "Unauthenticated" }, { status: 401 });
    const assertion = await issueControlApiGrant(
      resolved.session,
      "voice:read",
    );
    const config = loadConfig(process.env, { service: "web" });
    const client = new ControlApiClient(config.controlApiUrl, (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${assertion}`);
      return fetch(input, {
        ...init,
        cache: "no-store",
        headers,
      });
    });
    const result = await client.listVoiceSessions();
    return Response.json(result.data, { status: result.status });
  } catch (error) {
    if (error instanceof ForbiddenError)
      return Response.json({ error: "Forbidden" }, { status: 403 });
    return Response.json(
      { error: "Voice service unavailable" },
      { status: 503 },
    );
  }
}
