import { NextResponse } from "next/server";

import {
  createCalendarEvent,
  listCalendarEventPage,
  type CalendarEventInput,
  type CalendarEventStatus,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function listLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d{1,3}$/u.test(value))
    throw new TypeError("invalid calendar page size");
  const parsed = Number(value);
  if (parsed < 1 || parsed > 500)
    throw new TypeError("calendar page size must be 1 to 500");
  return parsed;
}

function listStatus(value: string | null): CalendarEventStatus | undefined {
  if (value === null) return undefined;
  if (value !== "confirmed" && value !== "tentative" && value !== "cancelled")
    throw new TypeError("invalid calendar event status");
  return value;
}

function dateParameter(value: string | null, name: string): Date | undefined {
  if (value === null) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    throw new TypeError(`${name} must be a valid date`);
  return parsed;
}

function nullableString(
  body: Record<string, unknown>,
  key: "description" | "location" | "organizerUserId",
): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null || typeof value === "string") return value;
  throw new TypeError(`${key} must be a string or null`);
}

function editableStatus(value: unknown): CalendarEventInput["status"] {
  if (value === undefined) return undefined;
  if (value !== "confirmed" && value !== "tentative")
    throw new TypeError("calendar event status must be confirmed or tentative");
  return value;
}

export async function GET(request: Request) {
  try {
    const parameters = new URL(request.url).searchParams;
    const status = listStatus(parameters.get("status"));
    const from = dateParameter(parameters.get("from"), "calendar range start");
    const to = dateParameter(parameters.get("to"), "calendar range end");
    const limit = listLimit(parameters.get("limit"));
    const cursorStartsAt = parameters.get("cursorStartsAt");
    const cursorEndsAt = parameters.get("cursorEndsAt");
    const cursorId = parameters.get("cursorId");
    const cursorPartCount = [cursorStartsAt, cursorEndsAt, cursorId].filter(
      (value) => value !== null,
    ).length;
    if (cursorPartCount !== 0 && cursorPartCount !== 3)
      throw new TypeError(
        "calendar cursorStartsAt, cursorEndsAt, and cursorId must be provided together",
      );
    if (cursorId !== null && !uuidPattern.test(cursorId))
      throw new TypeError("invalid calendar cursor identifier");
    const page = await withCurrentTenant("crm:read", (sql) =>
      listCalendarEventPage(sql, {
        ...(parameters.get("q") === null
          ? {}
          : { query: parameters.get("q") ?? "" }),
        ...(status === undefined ? {} : { status }),
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        ...(limit === undefined ? {} : { limit }),
        ...(cursorStartsAt === null ||
        cursorEndsAt === null ||
        cursorId === null
          ? {}
          : {
              cursor: {
                startsAt: cursorStartsAt,
                endsAt: cursorEndsAt,
                id: cursorId,
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
    if (
      typeof body.title !== "string" ||
      typeof body.startsAt !== "string" ||
      typeof body.endsAt !== "string" ||
      typeof body.timezone !== "string"
    ) {
      throw new TypeError(
        "calendar title, startsAt, endsAt, and timezone are required",
      );
    }
    if (body.allDay !== undefined && typeof body.allDay !== "boolean")
      throw new TypeError("allDay must be a boolean");
    const description = nullableString(body, "description");
    const location = nullableString(body, "location");
    const organizerUserId = nullableString(body, "organizerUserId");
    const status = editableStatus(body.status);
    const event = await withCurrentTenant("crm:write", (sql, session) =>
      createCalendarEvent(sql, session.userId, {
        title: body.title as string,
        startsAt: body.startsAt as string,
        endsAt: body.endsAt as string,
        timezone: body.timezone as string,
        ...(description === undefined ? {} : { description }),
        ...(location === undefined ? {} : { location }),
        ...(organizerUserId === undefined ? {} : { organizerUserId }),
        ...(body.allDay === undefined
          ? {}
          : { allDay: body.allDay as boolean }),
        ...(status === undefined ? {} : { status }),
      }),
    );
    return NextResponse.json({ event }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
