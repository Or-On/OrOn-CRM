import {
  ForbiddenError,
  UnauthenticatedError,
} from "../../../../../../features/auth";
import { voiceTranscriptResponse } from "../../../../../../features/voice-server";

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const upstream = await voiceTranscriptResponse(id);
    if (!upstream.ok) {
      return Response.json(
        {
          error:
            upstream.status === 404
              ? "Transcript not found"
              : "Voice service unavailable",
        },
        { status: upstream.status },
      );
    }
    return new Response(await upstream.text(), {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "text/plain; charset=utf-8",
      },
    });
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
