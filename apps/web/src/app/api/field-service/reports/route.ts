import { NextResponse } from "next/server";
import {
  listServiceReportPage,
  openReportDraft,
  serviceReportStatuses,
  type ServiceReportStatus,
} from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";
import { uuid } from "../../../../features/field-service";

function status(value: string | null): ServiceReportStatus | undefined {
  if (value === null) return undefined;
  if (!serviceReportStatuses.includes(value as ServiceReportStatus))
    throw new TypeError("Invalid service-report status");
  return value as ServiceReportStatus;
}

export async function GET(request: Request) {
  try {
    const parameters = new URL(request.url).searchParams;
    const selectedStatus = status(parameters.get("status"));
    const cursorAt = parameters.get("cursorAt") ?? undefined;
    const cursorId = parameters.get("cursorId") ?? undefined;
    if ((cursorAt === undefined) !== (cursorId === undefined))
      throw new TypeError("Both service-report cursor fields are required");
    if (cursorAt !== undefined && !Number.isFinite(Date.parse(cursorAt)))
      throw new TypeError("Service-report cursor is invalid");
    const parsedCursorId =
      cursorId === undefined ? undefined : uuid(cursorId, "Report cursor");
    const requestedLimit = Number(parameters.get("limit") ?? "50");
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1)
      throw new TypeError("Service-report page limit is invalid");
    const page = await withCurrentTenant("field-service:read", (sql) =>
      listServiceReportPage(sql, {
        ...(selectedStatus === undefined ? {} : { status: selectedStatus }),
        query: parameters.get("q") ?? "",
        limit: requestedLimit,
        ...(cursorAt === undefined || parsedCursorId === undefined
          ? {}
          : {
              cursor: {
                updatedAt: cursorAt,
                id: parsedCursorId,
              },
            }),
      }),
    );
    return NextResponse.json(page);
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const report = await withCurrentTenant(
      "field-service:operate",
      (sql, session) =>
        openReportDraft(
          sql,
          session.userId,
          uuid(body.caseId, "Case"),
          uuid(body.visitId, "Visit"),
          requestId(request),
        ),
    );
    return NextResponse.json({ report }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
