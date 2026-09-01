import { NextResponse } from "next/server";

import {
  assignConversation,
  setConversationStatus,
  type ConversationSummary,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

const statuses = new Set<ConversationSummary["status"]>([
  "open",
  "pending",
  "resolved",
  "closed",
]);

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/messaging/conversations/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const { id } = await context.params;
    const updated = await withCurrentTenant(
      "messaging:operate",
      async (sql) => {
        if ("assignedUserId" in body) {
          if (
            body.assignedUserId !== null &&
            typeof body.assignedUserId !== "string"
          )
            throw new TypeError("invalid conversation assignee");
          return assignConversation(
            sql,
            id,
            body.assignedUserId as string | null,
          );
        }
        if (
          typeof body.status !== "string" ||
          !statuses.has(body.status as ConversationSummary["status"])
        )
          throw new TypeError("invalid conversation status");
        return setConversationStatus(
          sql,
          id,
          body.status as ConversationSummary["status"],
        );
      },
    );
    return updated
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
