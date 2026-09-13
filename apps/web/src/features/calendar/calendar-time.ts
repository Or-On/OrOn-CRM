const dateKeyPattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
const dateTimeLocalPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u;

export interface CalendarTimeZoneResolution {
  readonly timeZone: string;
  readonly usedFallback: boolean;
}

/** Keeps Calendar available when an older tenant row contains an invalid zone. */
export function resolveCalendarTimeZone(
  value: string,
): CalendarTimeZoneResolution {
  const timeZone = value.trim();
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
    return { timeZone, usedFallback: false };
  } catch {
    return { timeZone: "UTC", usedFallback: true };
  }
}

interface DateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function numberPart(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === undefined) throw new RangeError(`Missing ${type} date part`);
  return Number(value);
}

function partsInTimeZone(
  value: Date | number,
  timeZone: string,
): DateTimeParts {
  const date = typeof value === "number" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid instant");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return {
    year: numberPart(parts, "year"),
    month: numberPart(parts, "month"),
    day: numberPart(parts, "day"),
    hour: numberPart(parts, "hour"),
    minute: numberPart(parts, "minute"),
    second: numberPart(parts, "second"),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dateKey(parts: Pick<DateTimeParts, "year" | "month" | "day">) {
  return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}`;
}

function parseDateKey(value: string) {
  const match = dateKeyPattern.exec(value);
  if (match === null) throw new RangeError("Invalid calendar date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== day
  ) {
    throw new RangeError("Invalid calendar date");
  }
  return { year, month, day };
}

function parseDateTimeLocal(value: string): DateTimeParts {
  const match = dateTimeLocalPattern.exec(value);
  if (match === null) throw new RangeError("Invalid local date and time");
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
  };
  const normalized = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  );
  if (
    normalized.getUTCFullYear() !== parts.year ||
    normalized.getUTCMonth() !== parts.month - 1 ||
    normalized.getUTCDate() !== parts.day ||
    normalized.getUTCHours() !== parts.hour ||
    normalized.getUTCMinutes() !== parts.minute ||
    normalized.getUTCSeconds() !== parts.second
  ) {
    throw new RangeError("Invalid local date and time");
  }
  return parts;
}

function sameDateTime(left: DateTimeParts, right: DateTimeParts) {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

function offsetAt(instant: number, timeZone: string): number {
  const local = partsInTimeZone(instant, timeZone);
  return (
    Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    ) -
    Math.trunc(instant / 1000) * 1000
  );
}

/** Converts an absolute instant to the wall-clock value expected by datetime-local. */
export function dateTimeLocalInTimeZone(
  value: string | Date,
  timeZone: string,
): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const parts = partsInTimeZone(date, timeZone);
  return `${dateKey(parts)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/**
 * Resolves a wall-clock date/time in an IANA zone to an instant.
 * Ambiguous fall-back times use the earlier occurrence; nonexistent spring-forward
 * times are rejected instead of silently moving the user's event.
 */
export function instantFromDateTimeLocal(
  value: string,
  timeZone: string,
): string {
  const desired = parseDateTimeLocal(value);
  // Construct the same fields as UTC, then sample offsets around that point. This
  // handles ordinary offsets as well as DST transitions without browser-local time.
  const nominal = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
    desired.second,
  );
  const offsets = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    offsets.add(offsetAt(nominal + hours * 3_600_000, timeZone));
  }
  const matches = [...offsets]
    .map((offset) => nominal - offset)
    .filter((candidate) =>
      sameDateTime(partsInTimeZone(candidate, timeZone), desired),
    )
    .sort((left, right) => left - right);
  const instant = matches[0];
  if (instant === undefined) {
    throw new RangeError(
      "This local time does not exist in the selected time zone",
    );
  }
  return new Date(instant).toISOString();
}

export function calendarDateKeyInTimeZone(
  value: string | Date,
  timeZone: string,
): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return dateKey(partsInTimeZone(date, timeZone));
}

export function calendarDateForFormatting(value: string): Date {
  const parts = parseDateKey(value);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
}

export function addCalendarDays(value: string, amount: number): string {
  const date = calendarDateForFormatting(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return dateKey({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
}

export function startOfCalendarWeek(value: string): string {
  const date = calendarDateForFormatting(value);
  return addCalendarDays(value, -date.getUTCDay());
}

export function calendarMonthDays(value: string): readonly string[] {
  const date = calendarDateForFormatting(value);
  const first = `${String(date.getUTCFullYear()).padStart(4, "0")}-${pad(date.getUTCMonth() + 1)}-01`;
  const start = startOfCalendarWeek(first);
  return Array.from({ length: 42 }, (_, index) =>
    addCalendarDays(start, index),
  );
}

export function startOfZonedCalendarDay(value: string, timeZone: string): Date {
  return new Date(instantFromDateTimeLocal(`${value}T00:00`, timeZone));
}
