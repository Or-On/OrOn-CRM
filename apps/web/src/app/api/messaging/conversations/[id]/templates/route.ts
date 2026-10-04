import { NextResponse } from "next/server";
import { crmErrorResponse } from "../../../../../../features/crm-route";
import { readConversationTemplates } from "../../../../../../features/inbox-templates/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const after = new URL(request.url).searchParams.get("after") ?? undefined;
    if (after && after.length > 2048)
      throw new TypeError("invalid template cursor");
    return NextResponse.json(await readConversationTemplates(id, after), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("template_catalog_"))
      return NextResponse.json(
        { error: error.message },
        { status: error.message.endsWith("rate_limited") ? 429 : 503 },
      );
    return crmErrorResponse(error);
  }
}
