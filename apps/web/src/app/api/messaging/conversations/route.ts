import { NextResponse } from "next/server";

import {
  listConversationPage,
  parseConversationCursor,
  type ConversationFilter,
} from "@or-on/crm";

import { withCurrentTenant } from "../../../../features/auth";
import { crmErrorResponse } from "../../../../features/crm-route";

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id") ?? undefined;
    const parameters = new URL(request.url).searchParams;
    if (
      id !== undefined &&
      !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(id)
    )
      throw new TypeError("Invalid conversation reference");
    const query = parameters.get("q")?.trim() ?? "";
    if (query.length > 120)
      throw new TypeError("Conversation search is too long");
    const requestedFilter = parameters.get("filter") ?? "all";
    if (
      ![
        "all",
        "mine",
        "unassigned",
        "unread",
        "open",
        "waiting",
        "closed",
      ].includes(requestedFilter)
    )
      throw new TypeError("Invalid conversation filter");
    const channel = parameters.get("channel");
    if (channel !== null && channel !== "whatsapp")
      throw new TypeError("Invalid conversation channel");
    const before = parseConversationCursor(
      parameters.get("before"),
      parameters.get("beforeId"),
    );
    const page = await withCurrentTenant("crm:read", (sql, session) =>
      listConversationPage(
        sql,
        id === undefined
          ? {
              query,
              filter: requestedFilter as ConversationFilter,
              currentUserId: session.userId,
              ...(channel === "whatsapp"
                ? { channelKind: "whatsapp" as const }
                : {}),
              ...(before === undefined ? {} : { before }),
            }
          : { conversationId: id, currentUserId: session.userId },
      ),
    );
    return NextResponse.json(page);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
