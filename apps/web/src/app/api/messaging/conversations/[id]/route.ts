import { NextResponse } from "next/server";

import {
  assignConversation,
  deleteConversation,
  markConversationRead,
  setConversationOwnership,
  setConversationStatus,
  type ConversationSummary,
} from "@or-on/crm";
import { loadConfig } from "@or-on/config";

import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";
import { deletePrivateObject } from "../../../../../features/private-objects";

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
      async (sql, session) => {
        if (body.read === true) {
          await markConversationRead(sql, id, session.userId);
          return true;
        }
        if (body.ownershipMode === "ai" || body.ownershipMode === "human") {
          if (
            body.ownershipMode === "ai" &&
            !loadConfig(process.env, { service: "web" }).enableWhatsAppAi
          )
            throw new TypeError(
              "WhatsApp AI is disabled by the platform operator",
            );
          if (
            body.ownershipMode === "ai" &&
            typeof body.agentProfileVersionId !== "string"
          )
            throw new TypeError("a published WhatsApp agent is required");
          return setConversationOwnership(
            sql,
            id,
            session.userId,
            body.ownershipMode,
            typeof body.agentProfileVersionId === "string"
              ? body.agentProfileVersionId
              : undefined,
            typeof body.reason === "string" ? body.reason : undefined,
          );
        }
        if ("assignedUserId" in body) {
          if (
            body.assignedUserId !== null &&
            typeof body.assignedUserId !== "string"
          )
            throw new TypeError("invalid conversation assignee");
          return assignConversation(sql, id, body.assignedUserId);
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

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/messaging/conversations/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const result = await withCurrentTenant(
      "messaging:operate",
      (sql, session) => deleteConversation(sql, id, session.userId),
    );
    if (result.status === "not_found")
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (result.status === "active_work")
      return NextResponse.json(
        {
          error:
            "This conversation still has queued or in-progress work. Wait for it to finish before deleting.",
        },
        { status: 409 },
      );
    if (result.status === "retained_evidence")
      return NextResponse.json(
        {
          error:
            "This conversation is retained as technician case evidence and cannot be deleted from the Inbox.",
        },
        { status: 409 },
      );

    const localObjects = result.privateObjects.filter(
      (object) => object.storageBackend === "local",
    );
    let storageCleanupPending =
      result.privateObjects.length - localObjects.length;
    for (let offset = 0; offset < localObjects.length; offset += 8) {
      const settled = await Promise.allSettled(
        localObjects
          .slice(offset, offset + 8)
          .map((object) => deletePrivateObject(object.storageKey)),
      );
      // The committed metadata tombstone keeps a failed object inaccessible
      // and eligible for a later storage-retention sweep. Never turn a
      // committed conversation deletion into a misleading request failure.
      storageCleanupPending += settled.filter(
        (outcome) => outcome.status === "rejected",
      ).length;
    }
    return NextResponse.json({ ok: true, storageCleanupPending });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
