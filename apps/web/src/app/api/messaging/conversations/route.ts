import { NextResponse } from "next/server";

import { listConversations } from "@or-on/crm";

import { withCurrentTenant } from "../../../../features/auth";
import { crmErrorResponse } from "../../../../features/crm-route";

export async function GET() {
  try {
    const conversations = await withCurrentTenant("crm:read", (sql) =>
      listConversations(sql),
    );
    return NextResponse.json({ conversations });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
