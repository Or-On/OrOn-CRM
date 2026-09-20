import { NextResponse } from "next/server";
import { listServiceQueue } from "@or-on/crm";
import { withCurrentTenant } from "../../../../features/auth";
import { crmErrorResponse } from "../../../../features/crm-route";

export async function GET(request: Request) {
  try {
    const view = new URL(request.url).searchParams.get("view") ?? "available";
    if (view !== "available" && view !== "mine")
      throw new TypeError("Invalid queue view");
    return NextResponse.json(
      await withCurrentTenant("field-service:operate", (sql) =>
        listServiceQueue(sql, view),
      ),
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
