import type { VoiceControlCommand } from "@or-on/api-client";

import {
  assertAuthenticatedMutation,
  ForbiddenError,
  jsonObject,
  UnauthenticatedError,
} from "../../../../../../features/auth";
import { voiceClient } from "../../../../../../features/voice-server";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
interface Context {
  readonly params: Promise<{ id: string }>;
}

function failure(status: number): Response {
  const safeStatus = [400, 401, 403, 404, 409, 422].includes(status)
    ? status
    : 503;
  const error =
    safeStatus === 409
      ? "Call control changed. Reload its current status."
      : safeStatus === 401
        ? "Unauthenticated"
        : safeStatus === 403
          ? "Forbidden"
          : safeStatus === 404
            ? "Call control unavailable"
            : safeStatus === 400 || safeStatus === 422
              ? "Invalid call control request"
              : "Call control result is unavailable. Check its status before retrying.";
  return Response.json({ error }, { status: safeStatus, headers });
}

function caught(error: unknown): Response {
  if (error instanceof UnauthenticatedError) return failure(401);
  if (error instanceof ForbiddenError) return failure(403);
  return failure(503);
}

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    if (!uuid.test(id)) return failure(400);
    const client = await voiceClient("voice:read", {
      freshAuthorization: true,
      timeoutMs: 4_000,
      signal: request.signal,
    });
    const result = await client.getVoiceSessionControl({ session_id: id });
    return result.ok
      ? Response.json(result.data, { status: result.status, headers })
      : failure(result.status);
  } catch (error) {
    return caught(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    await assertAuthenticatedMutation(request);
    const { id } = await context.params;
    if (!uuid.test(id)) return failure(400);
    let body: Record<string, unknown>;
    try {
      body = await jsonObject(request);
    } catch {
      return failure(400);
    }
    if (
      Object.keys(body).sort().join(",") !==
        "expected_epoch,idempotency_key,mode" ||
      (body.mode !== "paused" && body.mode !== "ai") ||
      typeof body.expected_epoch !== "number" ||
      !Number.isSafeInteger(body.expected_epoch) ||
      body.expected_epoch < 0 ||
      typeof body.idempotency_key !== "string" ||
      !/^[A-Za-z0-9._:-]{8,128}$/u.test(body.idempotency_key)
    )
      return failure(400);
    const command: VoiceControlCommand = {
      mode: body.mode,
      expected_epoch: body.expected_epoch,
      idempotency_key: body.idempotency_key,
    };
    const client = await voiceClient("voice:write", {
      freshAuthorization: true,
      timeoutMs: 4_000,
      signal: request.signal,
    });
    const result = await client.setVoiceSessionControl(
      { session_id: id },
      command,
    );
    return result.ok
      ? Response.json(result.data, { status: result.status, headers })
      : failure(result.status);
  } catch (error) {
    return caught(error);
  }
}
