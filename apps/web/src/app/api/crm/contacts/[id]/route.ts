import { NextResponse } from "next/server";

import { archiveContact, getContact } from "@or-on/crm";

import { withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/crm/contacts/[id]">,
) {
  try {
    const { id } = await context.params;
    const contact = await withCurrentTenant("crm:read", (sql) =>
      getContact(sql, id),
    );
    return contact === undefined
      ? NextResponse.json({ error: "Not found" }, { status: 404 })
      : NextResponse.json({ contact });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/crm/contacts/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const archived = await withCurrentTenant("crm:write", (sql) =>
      archiveContact(sql, id),
    );
    return archived
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
