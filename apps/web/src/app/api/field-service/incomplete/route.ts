import { NextResponse } from "next/server";
import {
  actOnIncompleteServiceRequest,
  listIncompleteServiceRequests,
} from "@or-on/crm";
import { jsonObject, withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";
import { uuid } from "../../../../features/field-service";

export async function GET() {
  try {
    const requests = await withCurrentTenant("field-service:read", (sql) =>
      listIncompleteServiceRequests(sql),
    );
    return NextResponse.json(
      { requests },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (
      body.action !== "retry" &&
      body.action !== "new_request" &&
      body.action !== "close"
    )
      throw new TypeError("פעולה לא תקינה");
    const action = body.action;
    await withCurrentTenant("field-service:manage", (sql) =>
      actOnIncompleteServiceRequest(
        sql,
        uuid(body.intakeId, "Intake"),
        action,
        uuid(body.operationId, "Operation"),
      ),
    );
    return NextResponse.json({
      message:
        action === "close"
          ? "הבקשה נסגרה."
          : "הבקשה הועברה לבדיקת זכאות ולתור השליחה.",
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
