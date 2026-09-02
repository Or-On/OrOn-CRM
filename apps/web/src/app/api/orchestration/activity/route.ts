import { NextResponse } from "next/server";

import { listContactActivity } from "@or-on/crm";

import { withCurrentTenant } from "../../../../features/auth";
import { crmErrorResponse } from "../../../../features/crm-route";

export async function GET(request: Request) {
  try {
    const contactId = new URL(request.url).searchParams.get("contactId");
    if (!contactId) throw new TypeError("contactId is required");
    const activity = await withCurrentTenant("crm:read", (sql) =>
      listContactActivity(sql, contactId),
    );
    return NextResponse.json({ activity });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
