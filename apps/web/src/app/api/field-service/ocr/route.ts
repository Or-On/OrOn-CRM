import { NextResponse } from "next/server";
import {
  listServiceOcrQueuePage,
  serviceOcrQueueViews,
  serviceOcrStatuses,
  type ServiceOcrQueueView,
  type ServiceOcrStatus,
} from "@or-on/crm";

import { withCurrentTenant } from "../../../../features/auth";
import { crmErrorResponse } from "../../../../features/crm-route";
import { uuid } from "../../../../features/field-service";

function queueView(value: string | null): ServiceOcrQueueView {
  if (value === null) return "attention";
  if (!serviceOcrQueueViews.includes(value as ServiceOcrQueueView))
    throw new TypeError("Invalid OCR queue view");
  return value as ServiceOcrQueueView;
}

function cursorStatus(value: string | null): ServiceOcrStatus | undefined {
  if (value === null) return undefined;
  if (!serviceOcrStatuses.includes(value as ServiceOcrStatus))
    throw new TypeError("Invalid OCR queue cursor status");
  return value as ServiceOcrStatus;
}

export async function GET(request: Request) {
  try {
    const parameters = new URL(request.url).searchParams;
    const view = queueView(parameters.get("view"));
    const query = parameters.get("q") ?? "";
    if (query.trim().length > 500)
      throw new TypeError("OCR queue search is too long");
    const cursorAt = parameters.get("cursorAt") ?? undefined;
    const cursorId = parameters.get("cursorId") ?? undefined;
    const selectedCursorStatus = cursorStatus(parameters.get("cursorStatus"));
    const cursorParts = [cursorAt, cursorId, selectedCursorStatus];
    if (
      cursorParts.some((value) => value !== undefined) &&
      cursorParts.some((value) => value === undefined)
    )
      throw new TypeError("All OCR queue cursor fields are required");
    if (cursorAt !== undefined && !Number.isFinite(Date.parse(cursorAt)))
      throw new TypeError("OCR queue cursor is invalid");
    const parsedCursorId =
      cursorId === undefined ? undefined : uuid(cursorId, "OCR queue cursor");
    const requestedLimit = Number(parameters.get("limit") ?? "24");
    if (
      !Number.isSafeInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > 500
    )
      throw new TypeError("OCR queue page limit is invalid");

    const page = await withCurrentTenant("field-service:read", (sql) =>
      listServiceOcrQueuePage(sql, {
        view,
        query,
        limit: requestedLimit,
        ...(cursorAt === undefined ||
        parsedCursorId === undefined ||
        selectedCursorStatus === undefined
          ? {}
          : {
              cursor: {
                status: selectedCursorStatus,
                createdAt: cursorAt,
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
