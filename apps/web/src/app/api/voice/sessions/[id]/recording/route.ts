import {
  ForbiddenError,
  UnauthenticatedError,
} from "../../../../../../features/auth";
import { voiceRecordingResponse } from "../../../../../../features/voice-server";

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const upstream = await voiceRecordingResponse(id, request.headers);
    if (
      (!upstream.ok && upstream.status !== 416) ||
      (upstream.body === null && upstream.status !== 416)
    ) {
      return Response.json(
        {
          error:
            upstream.status === 404
              ? "Recording not found"
              : "Voice service unavailable",
        },
        { status: upstream.status },
      );
    }
    const headers = new Headers({
      "cache-control": "private, no-store",
      "content-type": upstream.headers.get("content-type") ?? "audio/wav",
    });
    for (const name of [
      "content-length",
      "content-range",
      "accept-ranges",
      "content-disposition",
    ]) {
      const value = upstream.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    if (error instanceof UnauthenticatedError)
      return Response.json({ error: "Unauthenticated" }, { status: 401 });
    if (error instanceof ForbiddenError)
      return Response.json({ error: "Forbidden" }, { status: 403 });
    return Response.json(
      { error: "Voice service unavailable" },
      { status: 503 },
    );
  }
}
