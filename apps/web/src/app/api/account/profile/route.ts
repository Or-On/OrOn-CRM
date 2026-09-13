import { NextResponse } from "next/server";

import { updateCurrentUserProfile } from "@or-on/crm";

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
      typeof body.displayName !== "string" ||
      typeof body.email !== "string"
    ) {
      throw new TypeError("invalid profile update");
    }
    const emailChanged =
      body.email.trim().toLowerCase() !== session.email.toLowerCase();
    if (emailChanged) {
      if (typeof body.currentPassword !== "string")
        throw new ForbiddenError("Current password required");
      const valid = await withAuthService((service) =>
        service.verifyCurrentPassword(session, body.currentPassword as string),
      );
      if (!valid) throw new ForbiddenError("Current password is incorrect");
    }
    await withCurrentTenant("platform:read", (sql) =>
      updateCurrentUserProfile(
        sql,
        body.displayName as string,
        body.email as string,
        requestId(request),
      ),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
