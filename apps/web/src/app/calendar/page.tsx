import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  getTenantSettings,
  listCalendarEventPage,
  listTeamMembers,
} from "@or-on/crm";

import { AccessDenied } from "../../i18n/access-denied";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import {
  addCalendarDays,
  CalendarWorkspace,
  calendarDateKeyInTimeZone,
  calendarMonthDays,
  resolveCalendarTimeZone,
  startOfZonedCalendarDay,
} from "../../features/calendar";

function initialCalendarBounds(timeZone: string) {
  const days = calendarMonthDays(
    calendarDateKeyInTimeZone(new Date(), timeZone),
  );
  const first = days[0];
  const last = days.at(-1);
  if (first === undefined || last === undefined)
    throw new Error("calendar month range is empty");
  const from = startOfZonedCalendarDay(first, timeZone);
  const to = startOfZonedCalendarDay(addCalendarDays(last, 1), timeZone);
  return { from, to };
}

export default async function CalendarPage() {
  try {
    const data = await withCurrentTenant("crm:read", async (sql) => {
      const settings = await getTenantSettings(sql);
      const timezone = resolveCalendarTimeZone(settings.timezone);
      const bounds = initialCalendarBounds(timezone.timeZone);
      const [page, members] = await Promise.all([
        listCalendarEventPage(sql, {
          from: bounds.from,
          to: bounds.to,
          limit: 500,
        }),
        listTeamMembers(sql),
      ]);
      return { page, timezone, members, bounds };
    });
    return (
      <main className="page page--wide">
        <CalendarWorkspace
          defaultTimezone={data.timezone.timeZone}
          initialEvents={data.page.events}
          initialFrom={data.bounds.from.toISOString()}
          initialNextCursor={data.page.nextCursor}
          initialTo={data.bounds.to.toISOString()}
          members={data.members}
          timezoneFallback={data.timezone.usedFallback}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const metadata: Metadata = {
  title: "Calendar",
  description: "Tenant calendar and event planning.",
};
