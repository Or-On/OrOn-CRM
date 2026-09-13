import { NextResponse } from "next/server";

import {
  cancelCalendarEvent,
  updateCalendarEvent,
  type CalendarEventInput,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function optionalString(
  body: Record<string, unknown>,
  key: "title" | "startsAt" | "endsAt" | "timezone",
): string | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (typeof value === "string") return value;
  throw new TypeError(`${key} must be a string`);
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

function optionalStatus(value: unknown): CalendarEventInput["status"] {
  if (value === undefined) return undefined;
  if (value !== "confirmed" && value !== "tentative")
    throw new TypeError("calendar event status must be confirmed or tentative");
  return value;
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/calendar/events/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    if (!uuidPattern.test(id))
      throw new TypeError("invalid calendar event identifier");
    const body = await jsonObject(request);
    if (body.allDay !== undefined && typeof body.allDay !== "boolean")
      throw new TypeError("allDay must be a boolean");
    const title = optionalString(body, "title");
    const description = nullableString(body, "description");
    const location = nullableString(body, "location");
    const startsAt = optionalString(body, "startsAt");
    const endsAt = optionalString(body, "endsAt");
    const timezone = optionalString(body, "timezone");
    const status = optionalStatus(body.status);
    const organizerUserId = nullableString(body, "organizerUserId");
    const event = await withCurrentTenant("crm:write", (sql) =>
      updateCalendarEvent(sql, id, {
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(location === undefined ? {} : { location }),
        ...(startsAt === undefined ? {} : { startsAt }),
        ...(endsAt === undefined ? {} : { endsAt }),
        ...(body.allDay === undefined
          ? {}
          : { allDay: body.allDay as boolean }),
        ...(timezone === undefined ? {} : { timezone }),
        ...(status === undefined ? {} : { status }),
        ...(organizerUserId === undefined ? {} : { organizerUserId }),
      }),
    );
    return event === undefined
      ? NextResponse.json({ error: "Not found" }, { status: 404 })
      : NextResponse.json({ event });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/calendar/events/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    if (!uuidPattern.test(id))
      throw new TypeError("invalid calendar event identifier");
    const event = await withCurrentTenant("crm:write", (sql) =>
      cancelCalendarEvent(sql, id),
    );
    return event === undefined
      ? NextResponse.json({ error: "Not found" }, { status: 404 })
      : NextResponse.json({ event });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
