import { NextResponse } from "next/server";

import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../features/crm-route";

export async function GET() {
  try {
    const notifications = await withCurrentTenant("crm:read", (sql, session) =>
      listNotifications(sql, session.userId),
    );
    return NextResponse.json({ notifications });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const updated = await withCurrentTenant(
      "crm:read",
      async (sql, session) => {
        if (body.all === true)
          return markAllNotificationsRead(sql, session.userId);
        if (typeof body.id !== "string")
          throw new TypeError("notification id is required");
        return (await markNotificationRead(sql, session.userId, body.id))
          ? 1
          : 0;
      },
    );
    return NextResponse.json({ updated });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
