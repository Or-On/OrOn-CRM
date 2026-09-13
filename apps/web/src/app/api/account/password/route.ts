import { NextResponse } from "next/server";

import { hashPassword } from "@or-on/auth";
import { changeCurrentUserPassword } from "@or-on/crm";

import {
  assertAuthenticatedMutation,
  ForbiddenError,
  jsonObject,
  requestId,
  withAuthService,
  withCurrentTenant,
} from "../../../../features/auth";
import { crmErrorResponse } from "../../../../features/crm-route";

export async function PATCH(request: Request) {
  try {
    const session = await assertAuthenticatedMutation(request);
    const body = await jsonObject(request);
    if (
      typeof body.currentPassword !== "string" ||
      typeof body.newPassword !== "string" ||
      body.currentPassword === body.newPassword
    ) {
      throw new TypeError("invalid password update");
    }
    const valid = await withAuthService((service) =>
      service.verifyCurrentPassword(session, body.currentPassword as string),
    );
    if (!valid) throw new ForbiddenError("Current password is incorrect");
    const passwordHash = await hashPassword(body.newPassword);
    await withCurrentTenant("platform:read", (sql) =>
      changeCurrentUserPassword(
        sql,
        passwordHash,
        session.sessionId,
        requestId(request),
      ),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
