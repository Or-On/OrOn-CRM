import { NextResponse } from "next/server";

import { listConversations } from "@or-on/crm";

import { withCurrentTenant } from "../../../../features/auth";
import { crmErrorResponse } from "../../../../features/crm-route";

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id") ?? undefined;
    if (
      id !== undefined &&
      !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(id)
    )
      throw new TypeError("Invalid conversation reference");
    const conversations = await withCurrentTenant("crm:read", (sql) =>
      listConversations(sql, id),
    );
    return NextResponse.json({ conversations });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
