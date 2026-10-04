import { NextResponse } from "next/server";
import { withFreshCurrentTenant } from "../../../../../../features/auth";
import { crmErrorResponse } from "../../../../../../features/crm-route";
import {
  listConversationTemplates,
  templateAccount,
} from "../../../../../../features/inbox-templates-server";

export async function GET(
  request: Request,
  context: RouteContext<"/api/messaging/conversations/[id]/templates">,
) {
  try {
    const { id } = await context.params;
    const after = new URL(request.url).searchParams.get("after");
    let principal: string | undefined;
    const page = await listConversationTemplates(
      () =>
        withFreshCurrentTenant("messaging:operate", async (sql, session) => {
          const current = JSON.stringify([
            session.sessionId,
            session.userId,
            session.tenant.tenantId,
          ]);
          if (principal !== undefined && principal !== current)
            throw new Error("Template catalog principal changed");
          principal = current;
          return templateAccount(sql, id);
        }),
      after,
    );
    return NextResponse.json(page, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
