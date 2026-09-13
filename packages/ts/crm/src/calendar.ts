import type postgres from "postgres";

import type {
  CalendarEvent,
  CalendarEventCursor,
  CalendarEventInput,
  CalendarEventPage,
  CalendarEventStatus,
} from "./types.js";

interface CalendarEventRow {
  id: string;
  created_by_user_id: string | null;
  organizer_user_id: string | null;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: Date;
  ends_at: Date;
  all_day: boolean;
  timezone: string;
  status: CalendarEventStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CalendarEventListOptions {
  readonly query?: string;
  readonly status?: CalendarEventStatus;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit?: number;
  readonly cursor?: CalendarEventCursor;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requiredText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum)
    throw new TypeError(
      `${name} must contain between 1 and ${String(maximum)} characters`,
    );
  return normalized;
}

function nullableText(
  value: string | null | undefined,
  name: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (normalized.length > maximum)
    throw new TypeError(
      `${name} must contain no more than ${String(maximum)} characters`,
    );
  return normalized;
}

function eventStatus(value: string): Exclude<CalendarEventStatus, "cancelled"> {
  if (value !== "confirmed" && value !== "tentative")
    throw new TypeError("calendar event status must be confirmed or tentative");
  return value;
}

function instant(value: string, name: string): string {
  const normalized = value.trim();
  if (
    !/(?:Z|[+-]\d{2}:\d{2})$/u.test(normalized) ||
    !Number.isFinite(Date.parse(normalized))
  ) {
    throw new TypeError(
      `${name} must be an ISO 8601 instant with a time-zone offset`,
    );
  }
  return new Date(normalized).toISOString();
}

function timezoneName(value: string): string {
  const normalized = requiredText(value, "calendar timezone", 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone: normalized }).format(0);
  } catch {
    throw new TypeError(
      "calendar timezone must be a valid IANA time-zone name",
    );
  }
  return normalized;
}

function optionalMemberId(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const normalized = value.trim();
  if (!uuidPattern.test(normalized))
    throw new TypeError("invalid calendar organizer identifier");
  return normalized;
}

function dateBound(value: Date | undefined, name: string): Date | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value.getTime()))
    throw new TypeError(`${name} must be a valid date`);
  return value;
}

function mapCalendarEvent(row: CalendarEventRow): CalendarEvent {
  return {
    id: row.id,
    createdByUserId: row.created_by_user_id,
    organizerUserId: row.organizer_user_id,
    title: row.title,
    description: row.description,
    location: row.location,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    allDay: row.all_day,
    timezone: row.timezone,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listCalendarEvents(
  sql: postgres.TransactionSql,
  options: CalendarEventListOptions = {},
): Promise<readonly CalendarEvent[]> {
  return (await listCalendarEventPage(sql, options)).events;
}

export async function listCalendarEventPage(
  sql: postgres.TransactionSql,
  options: CalendarEventListOptions = {},
): Promise<CalendarEventPage> {
  const query = options.query?.trim() ?? "";
  if (query.length > 200) throw new TypeError("calendar search is too long");
  const status: string | null = options.status ?? null;
  if (
    status !== null &&
    status !== "confirmed" &&
    status !== "tentative" &&
    status !== "cancelled"
  ) {
    throw new TypeError("invalid calendar event status");
  }
  const from = dateBound(options.from, "calendar range start");
  const to = dateBound(options.to, "calendar range end");
  if (from !== null && to !== null && from >= to)
    throw new TypeError("calendar range end must be after its start");
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200), 1), 500);
  const cursorStartsAt =
    options.cursor === undefined
      ? null
      : instant(options.cursor.startsAt, "calendar cursor startsAt");
  const cursorEndsAt =
    options.cursor === undefined
      ? null
      : instant(options.cursor.endsAt, "calendar cursor endsAt");
  const cursorId = options.cursor?.id ?? null;
  if (cursorId !== null && !uuidPattern.test(cursorId))
    throw new TypeError("invalid calendar cursor identifier");
  const rows = await sql<CalendarEventRow[]>`
    SELECT id, created_by_user_id, organizer_user_id, title, description,
      location, starts_at, ends_at, all_day, timezone, status, created_at, updated_at
    FROM crm.calendar_events
    WHERE (${query}::text = '' OR title ILIKE '%' || ${query} || '%'
           OR coalesce(description, '') ILIKE '%' || ${query} || '%'
           OR coalesce(location, '') ILIKE '%' || ${query} || '%')
      AND (${status}::text IS NULL OR status = ${status})
      AND (${from}::timestamptz IS NULL OR ends_at > ${from}::timestamptz)
      AND (${to}::timestamptz IS NULL OR starts_at < ${to}::timestamptz)
      AND (${cursorStartsAt}::timestamptz IS NULL OR (starts_at, ends_at, id) >
        (${cursorStartsAt}::timestamptz, ${cursorEndsAt}::timestamptz, ${cursorId}::uuid))
    ORDER BY starts_at, ends_at, id
    LIMIT ${limit + 1}
  `;
  const hasNextPage = rows.length > limit;
  const events = rows.slice(0, limit).map(mapCalendarEvent);
  const last = events.at(-1);
  return {
    events,
    nextCursor:
      hasNextPage && last !== undefined
        ? { startsAt: last.startsAt, endsAt: last.endsAt, id: last.id }
        : null,
  };
}

export async function createCalendarEvent(
  sql: postgres.TransactionSql,
  actorUserId: string | null,
  input: CalendarEventInput,
): Promise<CalendarEvent> {
  const title = requiredText(input.title, "calendar event title", 240);
  const description = nullableText(
    input.description,
    "calendar event description",
    20_000,
  );
  const location = nullableText(input.location, "calendar event location", 500);
  const startsAt = instant(input.startsAt, "startsAt");
  const endsAt = instant(input.endsAt, "endsAt");
  if (Date.parse(endsAt) <= Date.parse(startsAt))
    throw new TypeError("calendar event end must be after its start");
  const timezone = timezoneName(input.timezone);
  const status =
    input.status === undefined ? "confirmed" : eventStatus(input.status);
  const organizerUserId = optionalMemberId(input.organizerUserId);
  const rows = await sql<CalendarEventRow[]>`
    INSERT INTO crm.calendar_events(
      tenant_id, created_by_user_id, organizer_user_id, title, description,
      location, starts_at, ends_at, all_day, timezone, status
    )
    SELECT platform.current_tenant_id(), ${actorUserId}::uuid,
      ${organizerUserId}::uuid, ${title}, ${description}, ${location},
      ${startsAt}::timestamptz, ${endsAt}::timestamptz,
      ${input.allDay ?? false}, ${timezone}, ${status}
    WHERE ${organizerUserId}::uuid IS NULL OR EXISTS (
      SELECT 1 FROM platform.current_tenant_team() member
      WHERE member.user_id = ${organizerUserId}::uuid
    )
    RETURNING id, created_by_user_id, organizer_user_id, title, description,
      location, starts_at, ends_at, all_day, timezone, status, created_at, updated_at
  `;
  const row = rows[0];
  if (row === undefined)
    throw new TypeError(
      "calendar organizer must be a member of the current tenant",
    );
  return mapCalendarEvent(row);
}

export async function updateCalendarEvent(
  sql: postgres.TransactionSql,
  eventId: string,
  input: Partial<CalendarEventInput>,
): Promise<CalendarEvent | undefined> {
  const changed =
    input.title !== undefined ||
    input.description !== undefined ||
    input.location !== undefined ||
    input.startsAt !== undefined ||
    input.endsAt !== undefined ||
    input.allDay !== undefined ||
    input.timezone !== undefined ||
    input.status !== undefined ||
    input.organizerUserId !== undefined;
  if (!changed)
    throw new TypeError("calendar event update contains no changes");
  const title =
    input.title === undefined
      ? null
      : requiredText(input.title, "calendar event title", 240);
  const description =
    input.description === undefined
      ? null
      : nullableText(input.description, "calendar event description", 20_000);
  const location =
    input.location === undefined
      ? null
      : nullableText(input.location, "calendar event location", 500);
  const startsAt =
    input.startsAt === undefined ? null : instant(input.startsAt, "startsAt");
  const endsAt =
    input.endsAt === undefined ? null : instant(input.endsAt, "endsAt");
  if (
    startsAt !== null &&
    endsAt !== null &&
    Date.parse(endsAt) <= Date.parse(startsAt)
  )
    throw new TypeError("calendar event end must be after its start");
  const timezone =
    input.timezone === undefined ? null : timezoneName(input.timezone);
  const status = input.status === undefined ? null : eventStatus(input.status);
  const organizerUserId =
    input.organizerUserId === undefined
      ? null
      : optionalMemberId(input.organizerUserId);
  const existingRows = await sql<{ starts_at: Date; ends_at: Date }[]>`
    SELECT starts_at, ends_at
    FROM crm.calendar_events
    WHERE id = ${eventId}::uuid AND status <> 'cancelled'
    FOR UPDATE
  `;
  const existing = existingRows[0];
  if (existing === undefined) return undefined;
  const effectiveStartsAt =
    startsAt === null ? existing.starts_at.getTime() : Date.parse(startsAt);
  const effectiveEndsAt =
    endsAt === null ? existing.ends_at.getTime() : Date.parse(endsAt);
  if (effectiveEndsAt <= effectiveStartsAt)
    throw new TypeError("calendar event end must be after its start");
  const rows = await sql<CalendarEventRow[]>`
    UPDATE crm.calendar_events
    SET title = CASE WHEN ${input.title !== undefined} THEN ${title} ELSE title END,
        description = CASE WHEN ${input.description !== undefined}
          THEN ${description} ELSE description END,
        location = CASE WHEN ${input.location !== undefined} THEN ${location} ELSE location END,
        starts_at = CASE WHEN ${input.startsAt !== undefined}
          THEN ${startsAt}::timestamptz ELSE starts_at END,
        ends_at = CASE WHEN ${input.endsAt !== undefined}
          THEN ${endsAt}::timestamptz ELSE ends_at END,
        all_day = CASE WHEN ${input.allDay !== undefined} THEN ${input.allDay ?? false}
          ELSE all_day END,
        timezone = CASE WHEN ${input.timezone !== undefined} THEN ${timezone} ELSE timezone END,
        status = CASE WHEN ${input.status !== undefined} THEN ${status} ELSE status END,
        organizer_user_id = CASE WHEN ${input.organizerUserId !== undefined}
          THEN ${organizerUserId}::uuid ELSE organizer_user_id END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${eventId}::uuid AND status <> 'cancelled'
      AND (
        ${input.organizerUserId === undefined} OR ${organizerUserId}::uuid IS NULL
        OR EXISTS (
          SELECT 1 FROM platform.current_tenant_team() member
          WHERE member.user_id = ${organizerUserId}::uuid
        )
      )
    RETURNING id, created_by_user_id, organizer_user_id, title, description,
      location, starts_at, ends_at, all_day, timezone, status, created_at, updated_at
  `;
  return rows[0] === undefined ? undefined : mapCalendarEvent(rows[0]);
}

export async function cancelCalendarEvent(
  sql: postgres.TransactionSql,
  eventId: string,
): Promise<CalendarEvent | undefined> {
  const rows = await sql<CalendarEventRow[]>`
    UPDATE crm.calendar_events
    SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
    WHERE id = ${eventId}::uuid AND status <> 'cancelled'
    RETURNING id, created_by_user_id, organizer_user_id, title, description,
      location, starts_at, ends_at, all_day, timezone, status, created_at, updated_at
  `;
  return rows[0] === undefined ? undefined : mapCalendarEvent(rows[0]);
}
