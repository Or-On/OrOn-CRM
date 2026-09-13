import { ControlApiClient } from "@or-on/api-client";
import { loadConfig } from "@or-on/config";
import { simulationRefusal } from "../../../../features/simulation-policy";

import {
  assertAuthenticatedMutation,
  ForbiddenError,
  issueControlApiGrant,
  jsonObject,
  UnauthenticatedError,
} from "../../../../features/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const refusal = simulationRefusal();
    if (refusal) return refusal;
    const config = loadConfig(process.env, { service: "web" });
    const session = await assertAuthenticatedMutation(request);
    const body = await jsonObject(request);
    if (
      typeof body.contactId !== "string" ||
      typeof body.idempotencyKey !== "string"
    ) {
      throw new TypeError("contactId and idempotencyKey are required");
    }
    const assertion = await issueControlApiGrant(session, "voice:write");
    const client = new ControlApiClient(config.controlApiUrl, (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${assertion}`);
      return fetch(input, { ...init, cache: "no-store", headers });
    });
    const result = await client.simulateVoiceCall({
      contact_id: body.contactId,
      idempotency_key: body.idempotencyKey,
      mode: "simulator",
    });
    return Response.json(result.data, { status: result.status });
  } catch (error) {
    if (error instanceof UnauthenticatedError)
      return Response.json({ error: "Unauthenticated" }, { status: 401 });
    if (error instanceof ForbiddenError)
      return Response.json({ error: "Forbidden" }, { status: 403 });
    if (error instanceof TypeError)
      return Response.json({ error: error.message }, { status: 400 });
    return Response.json(
      { error: "Voice simulator unavailable" },
      { status: 503 },
    );
  }
}
