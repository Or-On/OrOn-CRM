import type { ControlApiClient } from "@or-on/api-client";

import {
  assertAuthenticatedMutation,
  ForbiddenError,
  UnauthenticatedError,
} from "../../../features/auth";
import { voiceClient } from "../../../features/voice";

interface Upstream {
  readonly data: unknown;
  readonly status: number;
}

function failure(error: unknown): Response {
  if (error instanceof UnauthenticatedError)
    return Response.json({ error: "Unauthenticated" }, { status: 401 });
  if (error instanceof ForbiddenError)
    return Response.json({ error: "Forbidden" }, { status: 403 });
  if (error instanceof TypeError)
    return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ error: "Voice service unavailable" }, { status: 503 });
}

export async function voiceRead(
  operation: (client: ControlApiClient) => Promise<Upstream>,
): Promise<Response> {
  try {
    const result = await operation(await voiceClient("voice:read"));
    return Response.json(result.data, { status: result.status });
  } catch (error) {
    return failure(error);
  }
}

export async function voiceWrite(
  request: Request,
  operation: (client: ControlApiClient) => Promise<Upstream>,
): Promise<Response> {
  try {
    await assertAuthenticatedMutation(request);
    const result = await operation(await voiceClient("voice:write"));
    return Response.json(result.data, { status: result.status });
  } catch (error) {
    return failure(error);
  }
}
