import {
  ForbiddenError,
  UnauthenticatedError,
} from "../../../../../../features/auth";
import { voiceRecordingResponse } from "../../../../../../features/voice-server";

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const upstream = await voiceRecordingResponse(id);
    if (!upstream.ok || upstream.body === null) {
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
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers.set("content-length", contentLength);
    return new Response(upstream.body, { status: 200, headers });
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
