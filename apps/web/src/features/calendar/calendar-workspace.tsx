"use client";

import type {
  CalendarEvent,
  CalendarEventCursor,
  CalendarEventPage,
  CalendarEventStatus,
  TeamMember,
} from "@or-on/crm";
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  Input,
  Select,
  Textarea,
} from "@or-on/ui";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
} from "lucide-react";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";

import { useCapability } from "../access";
import { crmMutation, crmRead } from "../crm";
import {
  addCalendarDays,
  calendarDateForFormatting,
  calendarDateKeyInTimeZone,
  calendarMonthDays,
  dateTimeLocalInTimeZone,
  instantFromDateTimeLocal,
  startOfCalendarWeek,
  startOfZonedCalendarDay,
} from "./calendar-time";
import styles from "./calendar-workspace.module.css";

const COPY = {
  en: {
    title: "Calendar",
    events: "events",
    days: "days",
    today: "Today",
    month: "Month",
    week: "Week",
    day: "Day",
    add: "Add event",
    previous: "Previous period",
    next: "Next period",
    more: "more",
    noEvents: "No events in this period.",
    loading: "Loading calendar…",
    loadError:
      "The calendar could not be refreshed. The current view is still available.",
    close: "Close",
    createTitle: "Add event",
    editTitle: "Edit event",
    detailsTitle: "Event details",
    formDescription: "Events are saved to this tenant calendar.",
    eventTitle: "Event title",
    starts: "Starts",
    ends: "Ends",
    location: "Location",
    timezone: "Timezone",
    status: "Status",
    description: "Description",
    allDay: "All-day event",
    confirmed: "Confirmed",
    tentative: "Tentative",
    cancelled: "Cancelled",
    create: "Create event",
    save: "Save changes",
    cancelEvent: "Cancel event",
    keepEvent: "Keep event",
    confirmCancel: "Cancel this event?",
    cancelDescription:
      "The event remains in the calendar record and is marked cancelled.",
    saveError: "The event could not be saved. Your entries are still here.",
    cancelError: "The event could not be cancelled. Please try again.",
    allDayLabel: "All day",
    organizer: "Organizer",
    unassigned: "No organizer",
    formerMember: "Former member",
    moreAvailable: "More events are available in this period.",
    loadMore: "Load more events",
    loaded: "loaded",
    timesShownIn: "Times shown in",
    timezoneFallback:
      "The workspace timezone is invalid. Calendar times are shown in UTC until an administrator updates it in Settings.",
  },
  he: {
    title: "לוח שנה",
    events: "אירועים",
    days: "ימים",
    today: "היום",
    month: "חודש",
    week: "שבוע",
    day: "יום",
    add: "אירוע חדש",
    previous: "התקופה הקודמת",
    next: "התקופה הבאה",
    more: "נוספים",
    noEvents: "אין אירועים בתקופה הזאת.",
    loading: "לוח השנה נטען…",
    loadError: "לא הצלחנו לרענן את לוח השנה. התצוגה הנוכחית עדיין זמינה.",
    close: "סגירה",
    createTitle: "אירוע חדש",
    editTitle: "עריכת אירוע",
    detailsTitle: "פרטי האירוע",
    formDescription: "האירועים נשמרים בלוח השנה של הארגון.",
    eventTitle: "שם האירוע",
    starts: "התחלה",
    ends: "סיום",
    location: "מיקום",
    timezone: "אזור זמן",
    status: "סטטוס",
    description: "תיאור",
    allDay: "אירוע לכל היום",
    confirmed: "מאושר",
    tentative: "זמני",
    cancelled: "מבוטל",
    create: "יצירת אירוע",
    save: "שמירת שינויים",
    cancelEvent: "ביטול אירוע",
    keepEvent: "השארת האירוע",
    confirmCancel: "לבטל את האירוע?",
    cancelDescription: "האירוע יישאר ברשומת לוח השנה ויסומן כמבוטל.",
    saveError: "לא הצלחנו לשמור את האירוע. הפרטים שהוזנו נשמרו.",
    cancelError: "לא הצלחנו לבטל את האירוע. נסו שוב.",
    allDayLabel: "כל היום",
    organizer: "מארגן/ת",
    unassigned: "ללא מארגן/ת",
    formerMember: "חבר/ת צוות לשעבר",
    moreAvailable: "יש אירועים נוספים בתקופה הזאת.",
    loadMore: "טעינת אירועים נוספים",
    loaded: "נטענו",
    timesShownIn: "השעות מוצגות לפי",
    timezoneFallback:
      "אזור הזמן של סביבת העבודה אינו תקין. שעות לוח השנה מוצגות לפי UTC עד שמנהל/ת יעדכנו אותו בהגדרות.",
  },
} as const;

type View = "month" | "week" | "day";
interface Draft {
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timezone: string;
  status: CalendarEventStatus;
  organizerUserId: string;
}

function boundsFor(date: string, view: View, timeZone: string) {
  if (view === "month") {
    const days = calendarMonthDays(date);
    const firstDay = days[0];
    const lastDay = days.at(-1);
    if (firstDay === undefined || lastDay === undefined)
      throw new Error("calendar month range is empty");
    return {
      from: startOfZonedCalendarDay(firstDay, timeZone),
      to: startOfZonedCalendarDay(addCalendarDays(lastDay, 1), timeZone),
      days,
    };
  }
  const firstDay = view === "week" ? startOfCalendarWeek(date) : date;
  const count = view === "week" ? 7 : 1;
  return {
    from: startOfZonedCalendarDay(firstDay, timeZone),
    to: startOfZonedCalendarDay(addCalendarDays(firstDay, count), timeZone),
    days: Array.from({ length: count }, (_, index) =>
      addCalendarDays(firstDay, index),
    ),
  };
}

function eventIntersectsDay(
  event: CalendarEvent,
  day: string,
  timeZone: string,
) {
  const from = startOfZonedCalendarDay(day, timeZone).getTime();
  const to = startOfZonedCalendarDay(
    addCalendarDays(day, 1),
    timeZone,
  ).getTime();
  return (
    new Date(event.startsAt).getTime() < to &&
    new Date(event.endsAt).getTime() > from
  );
}

export function CalendarWorkspace({
  initialEvents,
  initialFrom,
  initialTo,
  initialNextCursor = null,
  defaultTimezone,
  members,
  timezoneFallback = false,
}: {
  readonly initialEvents: readonly CalendarEvent[];
  readonly initialFrom: string;
  readonly initialTo: string;
  readonly initialNextCursor?: CalendarEventCursor | null;
  readonly defaultTimezone: string;
  readonly members: readonly TeamMember[];
  readonly timezoneFallback?: boolean;
}) {
  const locale = useLocale();
  const t = COPY[locale.startsWith("he") ? "he" : "en"];
  const router = useRouter();
  const canEdit = useCapability("crm:write");
  const [events, setEvents] = useState([...initialEvents]);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState(() =>
    calendarDateKeyInTimeZone(new Date(), defaultTimezone),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CalendarEvent>();
  const [cancelling, setCancelling] = useState<CalendarEvent>();
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 3_600_000);
    return {
      title: "",
      description: "",
      location: "",
      startsAt: dateTimeLocalInTimeZone(start, defaultTimezone),
      endsAt: dateTimeLocalInTimeZone(end, defaultTimezone),
      allDay: false,
      timezone: defaultTimezone,
      status: "confirmed",
      organizerUserId: "",
    };
  });
  const firstRender = useRef(true);
  const bounds = useMemo(
    () => boundsFor(cursor, view, defaultTimezone),
    [cursor, defaultTimezone, view],
  );
  const initialKey = `${initialFrom}|${initialTo}`;
  const boundsKey = `${bounds.from.toISOString()}|${bounds.to.toISOString()}`;

  useEffect(() => {
    if (firstRender.current && view === "month" && boundsKey === initialKey) {
      firstRender.current = false;
      return;
    }
    firstRender.current = false;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    const query = new URLSearchParams({
      from: bounds.from.toISOString(),
      to: bounds.to.toISOString(),
      limit: "500",
    });
    void crmRead<CalendarEventPage>(
      `/api/calendar/events?${query}`,
      controller.signal,
    )
      .then((payload) => {
        setEvents([...payload.events]);
        setNextCursor(payload.nextCursor ?? null);
      })
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError"))
          setError(t.loadError);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [bounds.from, bounds.to, boundsKey, initialKey, t.loadError, view]);

  const eventCount = events.length;
  const heading =
    view === "month"
      ? new Intl.DateTimeFormat(locale, {
          month: "long",
          year: "numeric",
        }).format(calendarDateForFormatting(cursor))
      : view === "week"
        ? `${new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(calendarDateForFormatting(bounds.days[0] ?? cursor))} – ${new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(calendarDateForFormatting(bounds.days.at(-1) ?? cursor))}`
        : new Intl.DateTimeFormat(locale, {
            dateStyle: "full",
            timeZone: "UTC",
          }).format(calendarDateForFormatting(cursor));
  const weekdayLabels = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(locale, { weekday: "short" }).format(
      calendarDateForFormatting(
        addCalendarDays(startOfCalendarWeek(cursor), index),
      ),
    ),
  );
  const formatTime = (event: CalendarEvent) =>
    event.allDay
      ? t.allDayLabel
      : new Intl.DateTimeFormat(locale, {
          hour: "numeric",
          minute: "2-digit",
          timeZone: defaultTimezone,
        }).format(new Date(event.startsAt));
  const statusLabel = (status: CalendarEventStatus) =>
    status === "confirmed"
      ? t.confirmed
      : status === "tentative"
        ? t.tentative
        : t.cancelled;
  const memberLabel = (userId: string | null) => {
    if (userId === null) return t.unassigned;
    const member = members.find((candidate) => candidate.userId === userId);
    if (member === undefined) return t.formerMember;
    const displayName = member.displayName?.trim();
    return displayName === undefined || displayName === ""
      ? member.email
      : displayName;
  };

  function move(direction: -1 | 1) {
    setCursor((current) => {
      if (view !== "month")
        return addCalendarDays(current, direction * (view === "week" ? 7 : 1));
      const next = calendarDateForFormatting(current);
      next.setUTCMonth(next.getUTCMonth() + direction, 1);
      return calendarDateKeyInTimeZone(next, "UTC");
    });
  }

  function openCreate(day = cursor) {
    setEditing(undefined);
    setDraft({
      title: "",
      description: "",
      location: "",
      startsAt: `${day}T09:00`,
      endsAt: `${day}T10:00`,
      allDay: false,
      timezone: defaultTimezone,
      status: "confirmed",
      organizerUserId: "",
    });
    setError(undefined);
    setDialogOpen(true);
  }

  function openEdit(event: CalendarEvent) {
    setEditing(event);
    setDraft({
      title: event.title,
      description: event.description ?? "",
      location: event.location ?? "",
      startsAt: dateTimeLocalInTimeZone(event.startsAt, event.timezone),
      endsAt: dateTimeLocalInTimeZone(event.endsAt, event.timezone),
      allDay: event.allDay,
      timezone: event.timezone,
      status: event.status,
      organizerUserId: event.organizerUserId ?? "",
    });
    setError(undefined);
    setDialogOpen(true);
  }

  async function saveEvent(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.status === "cancelled") return;
    setPending(true);
    setError(undefined);
    try {
      const result = await crmMutation<{ event: CalendarEvent }>(
        editing ? `/api/calendar/events/${editing.id}` : "/api/calendar/events",
        {
          title: draft.title.trim(),
          description: draft.description.trim() || null,
          location: draft.location.trim() || null,
          startsAt: instantFromDateTimeLocal(draft.startsAt, draft.timezone),
          endsAt: instantFromDateTimeLocal(draft.endsAt, draft.timezone),
          allDay: draft.allDay,
          timezone: draft.timezone.trim(),
          status: draft.status,
          organizerUserId: draft.organizerUserId || null,
        },
        { method: editing ? "PATCH" : "POST" },
      );
      setEvents((current) =>
        editing
          ? current.map((item) =>
              item.id === result.event.id ? result.event : item,
            )
          : [...current, result.event].sort((left, right) =>
              left.startsAt.localeCompare(right.startsAt),
            ),
      );
      setDialogOpen(false);
      router.refresh();
    } catch {
      setError(t.saveError);
    } finally {
      setPending(false);
    }
  }

  async function confirmCancel() {
    if (!cancelling) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await crmMutation<{ event: CalendarEvent }>(
        `/api/calendar/events/${cancelling.id}`,
        {},
        { method: "DELETE" },
      );
      setEvents((current) =>
        current.map((item) =>
          item.id === result.event.id ? result.event : item,
        ),
      );
      setCancelling(undefined);
      setDialogOpen(false);
      router.refresh();
    } catch {
      setError(t.cancelError);
    } finally {
      setPending(false);
    }
  }

  function openCancel(event: CalendarEvent) {
    setError(undefined);
    setCancelling(event);
  }

  async function loadMoreEvents() {
    if (nextCursor === null) return;
    setLoading(true);
    setError(undefined);
    const query = new URLSearchParams({
      from: bounds.from.toISOString(),
      to: bounds.to.toISOString(),
      limit: "500",
      cursorStartsAt: nextCursor.startsAt,
      cursorEndsAt: nextCursor.endsAt,
      cursorId: nextCursor.id,
    });
    try {
      const payload = await crmRead<CalendarEventPage>(
        `/api/calendar/events?${query}`,
      );
      setEvents((current) => {
        const merged = new Map(current.map((item) => [item.id, item]));
        for (const item of payload.events) merged.set(item.id, item);
        return [...merged.values()].sort((left, right) =>
          left.startsAt.localeCompare(right.startsAt),
        );
      });
      setNextCursor(payload.nextCursor);
    } catch {
      setError(t.loadError);
    } finally {
      setLoading(false);
    }
  }

  const dialogReadOnly = !canEdit || editing?.status === "cancelled";

  const agenda = (
    <div className={styles.agenda}>
      {bounds.days.map((day) => {
        const dayEvents = events.filter((event) =>
          eventIntersectsDay(event, day, defaultTimezone),
        );
        return (
          <section className={styles.agendaDay} key={day}>
            <div className={styles.agendaDate}>
              <strong>{calendarDateForFormatting(day).getUTCDate()}</strong>
              {new Intl.DateTimeFormat(locale, {
                weekday: "short",
                month: "short",
                timeZone: "UTC",
              }).format(calendarDateForFormatting(day))}
            </div>
            <div className={styles.agendaEvents}>
              {dayEvents.length ? (
                dayEvents.map((event) => (
                  <button
                    className={styles.agendaEvent}
                    key={event.id}
                    onClick={() => openEdit(event)}
                    type="button"
                  >
                    <span className={styles.agendaTime}>
                      {formatTime(event)}
                    </span>
                    <span className={styles.agendaIdentity}>
                      <strong>{event.title}</strong>
                      <small>{memberLabel(event.organizerUserId)}</small>
                    </span>
                    <span className={styles.status} data-status={event.status}>
                      {statusLabel(event.status)}
                    </span>
                  </button>
                ))
              ) : (
                <button
                  className={styles.empty}
                  disabled={!canEdit}
                  onClick={() => openCreate(day)}
                  type="button"
                >
                  {t.noEvents}
                </button>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );

  return (
    <section
      className={styles.workspace}
      aria-busy={loading || pending || undefined}
    >
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <h1>{heading}</h1>
          <p>
            {bounds.days.length} {t.days} · {eventCount} {t.events}
            {nextCursor === null ? "" : "+"} · {t.timesShownIn}{" "}
            {defaultTimezone}
          </p>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.navigator}>
            <button
              aria-label={t.previous}
              onClick={() => move(-1)}
              type="button"
            >
              <ChevronLeft
                aria-hidden="true"
                className="directional-icon"
                size={15}
              />
            </button>
            <button
              onClick={() =>
                setCursor(
                  calendarDateKeyInTimeZone(new Date(), defaultTimezone),
                )
              }
              type="button"
            >
              {t.today}
            </button>
            <button aria-label={t.next} onClick={() => move(1)} type="button">
              <ChevronRight
                aria-hidden="true"
                className="directional-icon"
                size={15}
              />
            </button>
          </div>
          <div className={styles.viewTabs} aria-label={t.title}>
            {(["month", "week", "day"] as const).map((option) => (
              <button
                aria-pressed={view === option}
                key={option}
                onClick={() => setView(option)}
                type="button"
              >
                {t[option]}
              </button>
            ))}
          </div>
          {canEdit ? (
            <Button onClick={() => openCreate()} size="small">
              <Plus aria-hidden="true" size={15} />
              {t.add}
            </Button>
          ) : null}
        </div>
      </header>
      {timezoneFallback ? (
        <p className={styles.warning} role="alert">
          <AlertTriangle aria-hidden="true" size={16} />
          <span>{t.timezoneFallback}</span>
        </p>
      ) : null}
      {loading ? (
        <div
          className={styles.loadingBar}
          role="progressbar"
          aria-label={t.loading}
        />
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {view === "month" ? (
        <>
          <div className={styles.weekdays} aria-hidden="true">
            {weekdayLabels.map((label, index) => (
              <span key={[label, index].join("-")}>{label}</span>
            ))}
          </div>
          <div className={styles.monthGrid} role="grid" aria-label={heading}>
            {bounds.days.map((day) => {
              const dayEvents = events.filter((event) =>
                eventIntersectsDay(event, day, defaultTimezone),
              );
              const date = calendarDateForFormatting(day);
              const today =
                day === calendarDateKeyInTimeZone(new Date(), defaultTimezone);
              const outside =
                date.getUTCMonth() !==
                calendarDateForFormatting(cursor).getUTCMonth();
              return (
                <div
                  aria-current={today ? "date" : undefined}
                  aria-label={new Intl.DateTimeFormat(locale, {
                    dateStyle: "full",
                    timeZone: "UTC",
                  }).format(date)}
                  className={[
                    styles.dayCell ?? "",
                    today ? (styles.today ?? "") : "",
                    outside ? (styles.outside ?? "") : "",
                  ].join(" ")}
                  key={day}
                  onDoubleClick={() => canEdit && openCreate(day)}
                  role="gridcell"
                >
                  <span className={styles.dayNumber}>{date.getUTCDate()}</span>
                  <div className={styles.events}>
                    {dayEvents.slice(0, 3).map((event) => (
                      <button
                        className={styles.event}
                        data-status={event.status}
                        key={event.id}
                        onClick={() => openEdit(event)}
                        title={`${formatTime(event)} · ${event.title}`}
                        type="button"
                      >
                        <span>{event.title}</span>
                      </button>
                    ))}
                    {dayEvents.length > 3 ? (
                      <span className={styles.more}>
                        +{dayEvents.length - 3} {t.more}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          <div className={styles.mobileAgenda}>
            {/* Mobile month view */}
            {bounds.days
              .filter(
                (day) =>
                  calendarDateForFormatting(day).getUTCMonth() ===
                  calendarDateForFormatting(cursor).getUTCMonth(),
              )
              .map((day) => {
                const dayEvents = events.filter((event) =>
                  eventIntersectsDay(event, day, defaultTimezone),
                );
                if (!dayEvents.length) return null;
                return (
                  <section className={styles.agendaDay} key={`mobile-${day}`}>
                    <div className={styles.agendaDate}>
                      <strong>
                        {calendarDateForFormatting(day).getUTCDate()}
                      </strong>
                      {new Intl.DateTimeFormat(locale, {
                        weekday: "short",
                        month: "short",
                        timeZone: "UTC",
                      }).format(calendarDateForFormatting(day))}
                    </div>
                    <div className={styles.agendaEvents}>
                      {dayEvents.map((event) => (
                        <button
                          className={styles.agendaEvent}
                          key={event.id}
                          onClick={() => openEdit(event)}
                          type="button"
                        >
                          <span className={styles.agendaTime}>
                            {formatTime(event)}
                          </span>
                          <span className={styles.agendaIdentity}>
                            <strong>{event.title}</strong>
                            <small>{memberLabel(event.organizerUserId)}</small>
                          </span>
                          <span
                            className={styles.status}
                            data-status={event.status}
                          >
                            {statusLabel(event.status)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                );
              })}
            {eventCount === 0 ? (
              <div className={styles.empty}>{t.noEvents}</div>
            ) : null}
          </div>
        </>
      ) : (
        agenda
      )}

      {nextCursor === null ? null : (
        <div className={styles.limitNotice} role="status">
          <span>
            {eventCount} {t.loaded}. {t.moreAvailable}
          </span>
          <Button
            disabled={loading}
            onClick={() => void loadMoreEvents()}
            size="small"
            variant="quiet"
          >
            {t.loadMore}
          </Button>
        </div>
      )}

      <Dialog
        className={styles.dialog ?? ""}
        closeLabel={t.close}
        description={t.formDescription}
        onClose={() => setDialogOpen(false)}
        open={dialogOpen}
        title={
          editing
            ? dialogReadOnly
              ? t.detailsTitle
              : t.editTitle
            : t.createTitle
        }
      >
        <form
          className={styles.dialogForm}
          onSubmit={(event) => void saveEvent(event)}
        >
          <div className={styles.formGrid}>
            <div className={styles.full}>
              <Input
                autoFocus
                disabled={dialogReadOnly}
                id="calendar-title"
                label={t.eventTitle}
                maxLength={240}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                required
                value={draft.title}
              />
            </div>
            <Input
              disabled={dialogReadOnly}
              id="calendar-start"
              label={t.starts}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  startsAt: event.target.value,
                }))
              }
              required
              type="datetime-local"
              value={draft.startsAt}
            />
            <Input
              disabled={dialogReadOnly}
              id="calendar-end"
              label={t.ends}
              min={draft.startsAt}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  endsAt: event.target.value,
                }))
              }
              required
              type="datetime-local"
              value={draft.endsAt}
            />
            <Input
              disabled={dialogReadOnly}
              id="calendar-location"
              label={t.location}
              maxLength={500}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  location: event.target.value,
                }))
              }
              value={draft.location}
            />
            <Input
              disabled={dialogReadOnly}
              id="calendar-timezone"
              label={t.timezone}
              maxLength={100}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  timezone: event.target.value,
                }))
              }
              required
              value={draft.timezone}
            />
            <Select
              disabled={dialogReadOnly}
              id="calendar-status"
              label={t.status}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  status: event.target.value as Draft["status"],
                }))
              }
              value={draft.status}
            >
              <option value="confirmed">{t.confirmed}</option>
              <option value="tentative">{t.tentative}</option>
              {draft.status === "cancelled" ? (
                <option value="cancelled">{t.cancelled}</option>
              ) : null}
            </Select>
            <Select
              disabled={dialogReadOnly}
              id="calendar-organizer"
              label={t.organizer}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  organizerUserId: event.target.value,
                }))
              }
              value={draft.organizerUserId}
            >
              <option value="">{t.unassigned}</option>
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.displayName?.trim() ?? member.email}
                </option>
              ))}
            </Select>
            <div className={styles.checkboxRow}>
              <Checkbox
                checked={draft.allDay}
                disabled={dialogReadOnly}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    allDay: event.target.checked,
                  }))
                }
              >
                {t.allDay}
              </Checkbox>
            </div>
            <div className={styles.full}>
              <Textarea
                disabled={dialogReadOnly}
                id="calendar-description"
                label={t.description}
                maxLength={20000}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                rows={3}
                value={draft.description}
              />
            </div>
          </div>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <div className={styles.dialogActions}>
            {canEdit && editing && editing.status !== "cancelled" ? (
              <Button
                disabled={pending}
                onClick={() => openCancel(editing)}
                variant="danger"
              >
                <Trash2 aria-hidden="true" size={14} />
                {t.cancelEvent}
              </Button>
            ) : (
              <span />
            )}
            <div className={styles.dialogPrimaryActions}>
              <Button
                disabled={pending}
                onClick={() => setDialogOpen(false)}
                variant="quiet"
              >
                {t.close}
              </Button>
              {canEdit && editing?.status !== "cancelled" ? (
                <Button busy={pending} type="submit">
                  {editing ? t.save : t.create}
                </Button>
              ) : null}
            </div>
          </div>
        </form>
      </Dialog>
      <ConfirmDialog
        busy={pending}
        cancelLabel={t.keepEvent}
        confirmLabel={t.cancelEvent}
        description={t.cancelDescription}
        destructive
        onCancel={() => setCancelling(undefined)}
        onConfirm={() => void confirmCancel()}
        open={cancelling !== undefined}
        title={t.confirmCancel}
      >
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
