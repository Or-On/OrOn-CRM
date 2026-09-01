import { NextResponse } from "next/server";

import { addContactNote } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

export async function POST(
  request: Request,
  context: RouteContext<"/api/crm/contacts/[id]/notes">,
) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (typeof body.body !== "string")
      throw new TypeError("note body is required");
    const { id } = await context.params;
    const note = await withCurrentTenant("crm:write", (sql, session) =>
      addContactNote(sql, id, session.userId, body.body as string),
    );
    return NextResponse.json({ note }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
