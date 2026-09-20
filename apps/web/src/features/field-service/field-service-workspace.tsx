"use client";

import type {
  ContactSummary,
  FieldServiceFeatureState,
  ServiceAppointment,
  ServiceCaseCursor,
  ServiceCaseSummary,
  ServiceDirectory as Directory,
  TeamMember,
  TechnicianSummary,
} from "@or-on/crm";
import {
  AnimatedNumber,
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  InlineFeedback,
  Input,
  Select,
  Surface,
  Textarea,
} from "@or-on/ui";
import {
  CalendarClock,
  ChevronRight,
  CircleCheckBig,
  Clock3,
  MapPin,
  Plus,
  Search,
  Sparkles,
  UserRoundCog,
  Wrench,
} from "lucide-react";
import { useLocale } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type SyntheticEvent } from "react";

import {
  dateTimeLocalInTimeZone,
  instantFromDateTimeLocal,
} from "../calendar/calendar-time";
import { crmMutation, crmRead } from "../crm";
import {
  appointmentStatusLabel,
  casePriorityLabel,
  caseStatusLabel,
  technicianIdentityLabel,
} from "./field-service-labels";
import { FieldServiceNavigation } from "./field-service-navigation";
import { TechnicianQueue } from "./technician-queue";
import { ServiceDirectory } from "./service-directory";

type View = "cases" | "schedule" | "technicians" | "my-work" | "directory";

function caseTone(status: ServiceCaseSummary["status"]) {
  if (status === "completed" || status === "closed") return "positive" as const;
  if (status === "cancelled") return "critical" as const;
  if (status === "in_progress") return "warning" as const;
  return "neutral" as const;
}

function DialogError({ message }: { readonly message: string | undefined }) {
  return message === undefined ? null : (
    <InlineFeedback
      className="field-service-dialog-feedback"
      description={message}
      tone="critical"
    />
  );
}

export function FieldServiceWorkspace({
  appointments,
  cases: initialCases,
  contacts,
  feature,
  technicians,
  technicianAccounts = [],
  nextCaseCursor: initialNextCaseCursor = null,
  timezone,
  canManage,
  canOperate,
  isTechnician = false,
  serviceStores = [],
}: {
  readonly appointments: readonly ServiceAppointment[];
  readonly cases: readonly ServiceCaseSummary[];
  readonly nextCaseCursor?: ServiceCaseCursor | null;
  readonly contacts: readonly ContactSummary[];
  readonly feature: FieldServiceFeatureState;
  readonly technicians: readonly TechnicianSummary[];
  readonly technicianAccounts?: readonly TeamMember[];
  readonly timezone: string;
  readonly canManage: boolean;
  readonly canOperate: boolean;
  readonly isTechnician?: boolean;
  readonly serviceStores?: Directory["stores"];
}) {
  const locale = useLocale();
  const he = locale.startsWith("he");
  const router = useRouter();
  const [view, setView] = useState<View>(isTechnician ? "my-work" : "cases");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [cases, setCases] =
    useState<readonly ServiceCaseSummary[]>(initialCases);
  const [nextCaseCursor, setNextCaseCursor] =
    useState<ServiceCaseCursor | null>(initialNextCaseCursor);
  const [loadingCases, setLoadingCases] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createCustomerId, setCreateCustomerId] = useState("");
  const [contactQuery, setContactQuery] = useState("");
  const [contactOptions, setContactOptions] =
    useState<readonly ContactSummary[]>(contacts);
  const [scheduleCase, setScheduleCase] = useState<ServiceCaseSummary>();
  const [manageAppointment, setManageAppointment] =
    useState<ServiceAppointment>();
  const [technicianOpen, setTechnicianOpen] = useState(false);
  const [editingTechnician, setEditingTechnician] =
    useState<TechnicianSummary>();
  const [pendingAction, setPendingAction] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setCases(initialCases);
    setNextCaseCursor(initialNextCaseCursor);
    setAppliedQuery("");
  }, [initialCases, initialNextCaseCursor]);
  useEffect(() => setContactOptions(contacts), [contacts]);
  const active = cases.filter((item) =>
    ["scheduled", "in_progress"].includes(item.status),
  ).length;
  const awaiting = cases.filter(
    (item) => item.status === "awaiting_scheduling",
  ).length;
  const completed = cases.filter((item) =>
    ["completed", "closed"].includes(item.status),
  ).length;
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase(locale);
    return term === ""
      ? cases
      : cases.filter((item) =>
          `${item.reference} ${item.customerName} ${item.title}`
            .toLocaleLowerCase(locale)
            .includes(term),
        );
  }, [cases, locale, query]);
  const dialogOpen =
    createOpen ||
    scheduleCase !== undefined ||
    technicianOpen ||
    editingTechnician !== undefined ||
    manageAppointment !== undefined;

  const pending = pendingAction !== undefined;

  async function run(action: string, operation: () => Promise<void>) {
    setPendingAction(action);
    setError(undefined);
    try {
      await operation();
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : he
            ? "הפעולה נכשלה"
            : "The operation failed",
      );
    } finally {
      setPendingAction(undefined);
    }
  }

  function openCreateDialog() {
    setError(undefined);
    setCreateCustomerId("");
    setCreateOpen(true);
  }

  function closeCreateDialog() {
    setError(undefined);
    setCreateOpen(false);
  }

  function openScheduleDialog(serviceCase: ServiceCaseSummary) {
    setError(undefined);
    setScheduleCase(serviceCase);
  }

  function closeScheduleDialog() {
    setError(undefined);
    setScheduleCase(undefined);
  }

  function openTechnicianDialog() {
    setError(undefined);
    setTechnicianOpen(true);
  }

  function closeTechnicianDialog() {
    setError(undefined);
    setTechnicianOpen(false);
  }

  function openEditTechnicianDialog(technician: TechnicianSummary) {
    setError(undefined);
    setEditingTechnician(technician);
  }

  function closeEditTechnicianDialog() {
    setError(undefined);
    setEditingTechnician(undefined);
  }

  function openManageAppointmentDialog(appointment: ServiceAppointment) {
    setError(undefined);
    setManageAppointment(appointment);
  }

  function closeManageAppointmentDialog() {
    setError(undefined);
    setManageAppointment(undefined);
  }

  async function fetchCasePage(options: {
    readonly append: boolean;
    readonly query: string;
    readonly cursor?: ServiceCaseCursor;
  }) {
    if (loadingCases) return;
    setLoadingCases(true);
    setError(undefined);
    try {
      const parameters = new URLSearchParams({ limit: "50" });
      if (options.query.trim() !== "")
        parameters.set("q", options.query.trim());
      if (options.cursor !== undefined) {
        parameters.set("cursorAt", options.cursor.updatedAt);
        parameters.set("cursorId", options.cursor.id);
      }
      const page = await crmRead<{
        readonly cases: readonly ServiceCaseSummary[];
        readonly nextCursor: ServiceCaseCursor | null;
      }>(`/api/field-service/cases?${parameters.toString()}`);
      setCases((current) => {
        if (!options.append) return page.cases;
        const merged = new Map(current.map((item) => [item.id, item]));
        for (const item of page.cases) merged.set(item.id, item);
        return [...merged.values()];
      });
      setAppliedQuery(options.query.trim());
      setNextCaseCursor(page.nextCursor);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not load service cases",
      );
    } finally {
      setLoadingCases(false);
    }
  }

  async function searchContactOptions() {
    setLoadingCases(true);
    setError(undefined);
    try {
      const parameters = new URLSearchParams({
        limit: "50",
        q: contactQuery.trim(),
      });
      const page = await crmRead<{
        readonly contacts: readonly ContactSummary[];
      }>(`/api/crm/contacts?${parameters.toString()}`);
      setContactOptions(page.contacts);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not search contacts",
      );
    } finally {
      setLoadingCases(false);
    }
  }

  async function createCase(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("serviceLocationId") === "") form.delete("serviceLocationId");
    await run("create-case", async () => {
      await crmMutation(
        "/api/field-service/cases",
        Object.fromEntries(form.entries()),
      );
      closeCreateDialog();
    });
  }

  async function schedule(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (scheduleCase === undefined) return;
    const form = new FormData(event.currentTarget);
    const startsAtValue = form.get("startsAt");
    const startsAt = instantFromDateTimeLocal(
      typeof startsAtValue === "string" ? startsAtValue : "",
      timezone,
    );
    const start = new Date(startsAt);
    const durationMinutes = Number(form.get("durationMinutes"));
    const end = new Date(start.valueOf() + durationMinutes * 60_000);
    await run("schedule", async () => {
      await crmMutation(
        "/api/field-service/appointments",
        {
          caseId: scheduleCase.id,
          technicianId: form.get("technicianId"),
          startsAt,
          endsAt: end.toISOString(),
          timezone,
          notes: form.get("notes"),
          action: "schedule",
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      closeScheduleDialog();
    });
  }

  async function suggestSchedule(event: SyntheticEvent<HTMLButtonElement>) {
    const formElement = event.currentTarget.form;
    if (scheduleCase === undefined || formElement === null) return;
    const form = new FormData(formElement);
    await run("suggest", async () => {
      await crmMutation(
        "/api/field-service/appointments",
        {
          action: "suggest",
          caseId: scheduleCase.id,
          durationMinutes: Number(form.get("durationMinutes")),
          earliestAt: new Date().toISOString(),
          timezone,
          notes: form.get("notes"),
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      closeScheduleDialog();
    });
  }

  async function createTechnician(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const linkedUserId = form.get("linkedUserId");
    await run("create-technician", async () => {
      await crmMutation("/api/field-service/technicians", {
        fullName: form.get("fullName"),
        employeeIdentifier: form.get("employeeIdentifier"),
        phone: form.get("phone"),
        email: form.get("email"),
        linkedUserId:
          typeof linkedUserId === "string" && linkedUserId !== ""
            ? linkedUserId
            : null,
        verified: form.get("verified") === "true",
      });
      closeTechnicianDialog();
    });
  }

  async function editTechnician(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editingTechnician === undefined) return;
    const form = new FormData(event.currentTarget);
    const linkedUserId = form.get("linkedUserId");
    await run("edit-technician", async () => {
      await crmMutation(
        `/api/field-service/technicians/${editingTechnician.id}`,
        {
          fullName: form.get("fullName"),
          employeeIdentifier: form.get("employeeIdentifier"),
          phone: form.get("phone"),
          email: form.get("email"),
          linkedUserId:
            typeof linkedUserId === "string" && linkedUserId !== ""
              ? linkedUserId
              : null,
          verified: form.get("verified") === "true",
          active: form.get("active") === "true",
        },
        { method: "PATCH" },
      );
      closeEditTechnicianDialog();
    });
  }

  async function changeAppointment(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (manageAppointment === undefined) return;
    const form = new FormData(event.currentTarget);
    const startsAtValue = form.get("startsAt");
    const startsAt = instantFromDateTimeLocal(
      typeof startsAtValue === "string" ? startsAtValue : "",
      manageAppointment.timezone,
    );
    const durationMinutes = Number(form.get("durationMinutes"));
    const endsAt = new Date(
      Date.parse(startsAt) + durationMinutes * 60_000,
    ).toISOString();
    await run("reschedule", async () => {
      await crmMutation(
        `/api/field-service/appointments/${manageAppointment.id}`,
        {
          action: "reschedule",
          technicianId: form.get("technicianId"),
          startsAt,
          endsAt,
          timezone: manageAppointment.timezone,
          notes: form.get("notes"),
        },
        { idempotencyKey: crypto.randomUUID(), method: "PATCH" },
      );
      closeManageAppointmentDialog();
    });
  }

  async function approveAppointment() {
    if (manageAppointment === undefined) return;
    await run("approve", async () => {
      await crmMutation(
        `/api/field-service/appointments/${manageAppointment.id}`,
        { action: "approve" },
        { method: "PATCH" },
      );
      closeManageAppointmentDialog();
    });
  }

  async function cancelAppointment() {
    if (manageAppointment === undefined) return;
    await run("cancel", async () => {
      await crmMutation(
        `/api/field-service/appointments/${manageAppointment.id}`,
        { action: "cancel" },
        { method: "PATCH" },
      );
      closeManageAppointmentDialog();
    });
  }

  return (
    <div className="field-service-workspace">
      <header className="platform-admin-hero field-service-hero">
        <div className="platform-admin-hero__copy">
          <span className="eyebrow">
            {he ? "תפעול שירות" : "Service operations"}
          </span>
          <h1>{he ? "שירות שטח" : "Field service"}</h1>
          <p>
            {isTechnician
              ? he
                ? "בוחרים אירוע פנוי, מטפלים בתקלה ומשלימים את הדוח מהשטח."
                : "Choose an available incident, resolve the issue, and complete your field report."
              : he
                ? "מנהלים תיקים, ביקורים, ראיות ודוחות חתומים במקום אחד."
                : "Coordinate cases, visits, evidence, and signed reports in one workspace."}
          </p>
        </div>
        {canOperate && !isTechnician ? (
          <Button
            className="platform-admin-hero__action"
            onClick={openCreateDialog}
          >
            <Plus aria-hidden="true" size={16} />
            {he ? "תיק שירות חדש" : "New service case"}
          </Button>
        ) : null}
      </header>

      <FieldServiceNavigation active="overview" />

      {!isTechnician ? (
        <section
          className="field-service-metrics"
          aria-label={he ? "סקירת שירות" : "Service overview"}
        >
          {[
            {
              icon: Wrench,
              label: he ? "תיקים שנטענו" : "Loaded cases",
              value: cases.length,
            },
            {
              icon: Clock3,
              label: he ? "ממתינים לתזמון" : "Awaiting schedule",
              value: awaiting,
            },
            {
              icon: CalendarClock,
              label: he ? "פעילים" : "Active visits",
              value: active,
            },
            {
              icon: CircleCheckBig,
              label: he ? "הושלמו" : "Completed",
              value: completed,
            },
          ].map(({ icon: Icon, label, value }) => (
            <Surface as="article" key={label} level="raised">
              <span className="field-service-metric__icon">
                <Icon aria-hidden="true" size={19} />
              </span>
              <span>
                <small>{label}</small>
                <strong>
                  <AnimatedNumber
                    animateOnMount
                    locale={locale}
                    value={value}
                  />
                </strong>
              </span>
            </Surface>
          ))}
        </section>
      ) : null}

      <div className="field-service-toolbar">
        <div
          className="field-service-tabs"
          role="tablist"
          aria-label={he ? "תצוגת שירות" : "Service view"}
        >
          {(
            [
              ...(isTechnician ? ["my-work" as const] : []),
              "cases",
              "schedule",
              ...(canManage
                ? ["technicians" as const, "directory" as const]
                : []),
            ] as readonly View[]
          ).map((item) => (
            <button
              aria-selected={view === item}
              aria-controls="field-service-panel"
              id={`field-service-tab-${item}`}
              tabIndex={view === item ? 0 : -1}
              key={item}
              onClick={() => setView(item)}
              onKeyDown={(event) => {
                const buttons = Array.from(
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]',
                  ) ?? [],
                );
                const position = buttons.indexOf(event.currentTarget);
                const delta =
                  event.key === "ArrowRight"
                    ? he
                      ? -1
                      : 1
                    : event.key === "ArrowLeft"
                      ? he
                        ? 1
                        : -1
                      : 0;
                const next =
                  event.key === "Home"
                    ? buttons[0]
                    : event.key === "End"
                      ? buttons.at(-1)
                      : delta
                        ? buttons[
                            (position + delta + buttons.length) % buttons.length
                          ]
                        : undefined;
                if (next) {
                  event.preventDefault();
                  next.click();
                  next.focus();
                }
              }}
              role="tab"
              type="button"
            >
              {item === "directory"
                ? he
                  ? "רשתות וסניפים"
                  : "Chains & stores"
                : item === "my-work"
                  ? he
                    ? "העבודה שלי"
                    : "My work"
                  : he
                    ? item === "cases"
                      ? "תיקים"
                      : item === "schedule"
                        ? "לוח זמנים"
                        : "טכנאים"
                    : item === "cases"
                      ? "Cases"
                      : item === "schedule"
                        ? "Schedule"
                        : "Technicians"}
            </button>
          ))}
        </div>
        {view === "cases" ? (
          <form
            className="field-service-search"
            onSubmit={(event) => {
              event.preventDefault();
              void fetchCasePage({ append: false, query });
            }}
            role="search"
          >
            <Search aria-hidden="true" size={15} />
            <label
              className="or-visually-hidden"
              htmlFor="field-service-case-search"
            >
              {he ? "חיפוש תיקים" : "Search cases"}
            </label>
            <input
              id="field-service-case-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                he ? "חיפוש לפי לקוח או מזהה…" : "Search customer or reference…"
              }
              type="search"
              value={query}
            />
            <button className="or-visually-hidden" type="submit">
              {he ? "חיפוש" : "Search"}
            </button>
          </form>
        ) : null}
      </div>

      {error && !dialogOpen ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div
        role="tabpanel"
        id="field-service-panel"
        aria-labelledby={`field-service-tab-${view}`}
        tabIndex={0}
      >
        {view === "directory" ? (
          <ServiceDirectory contacts={contacts} />
        ) : view === "my-work" ? (
          <TechnicianQueue canClaim={isTechnician} />
        ) : view === "cases" ? (
          filtered.length === 0 ? (
            <Surface level="raised">
              <EmptyState
                title={he ? "אין תיקי שירות" : "No service cases"}
                description={
                  query
                    ? he
                      ? "אין תוצאות לחיפוש הזה."
                      : "No cases match this search."
                    : he
                      ? "תיק שאושר ב-WhatsApp או נפתח ידנית יופיע כאן."
                      : "A confirmed WhatsApp intake or manually opened case will appear here."
                }
              />
            </Surface>
          ) : (
            <Surface className="field-service-directory" level="raised">
              <DataTable
                label={he ? "תיקי שירות" : "Service cases"}
                minWidth="58rem"
              >
                <thead>
                  <tr>
                    <th>{he ? "תיק" : "Case"}</th>
                    <th>{he ? "לקוח ומיקום" : "Customer & location"}</th>
                    <th>{he ? "תקלה" : "Issue"}</th>
                    <th>{he ? "סטטוס" : "Status"}</th>
                    <th>{he ? "עודכן" : "Updated"}</th>
                    <th>
                      <span className="or-visually-hidden">
                        {he ? "פעולות" : "Actions"}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <Link
                          className="field-service-case-link"
                          href={`/field-service/cases/${item.id}`}
                        >
                          <strong dir="ltr">{item.reference}</strong>
                          <small>{casePriorityLabel(item.priority, he)}</small>
                        </Link>
                      </td>
                      <td>
                        <strong dir="auto">{item.customerName}</strong>
                        <small>
                          <MapPin aria-hidden="true" size={12} />{" "}
                          <bdi dir="auto">
                            {item.serviceLocationName ??
                              (he ? "ללא מיקום" : "No location")}
                          </bdi>
                        </small>
                      </td>
                      <td>
                        <strong dir="auto">{item.title}</strong>
                        <small>
                          <bdi dir="auto">
                            {item.productModel ??
                              (he ? "דגם לא צוין" : "Model not supplied")}
                          </bdi>
                        </small>
                      </td>
                      <td>
                        <Badge
                          label={caseStatusLabel(item.status, he)}
                          tone={caseTone(item.status)}
                        />
                      </td>
                      <td data-label={he ? "עודכן" : "Updated"}>
                        <time dateTime={item.updatedAt}>
                          {new Intl.DateTimeFormat(locale, {
                            dateStyle: "medium",
                            timeZone: timezone,
                          }).format(new Date(item.updatedAt))}
                        </time>
                      </td>
                      <td>
                        <div className="field-service-row-actions">
                          {canOperate &&
                          item.status === "awaiting_scheduling" ? (
                            <Button
                              onClick={() => openScheduleDialog(item)}
                              size="small"
                              variant="secondary"
                            >
                              {he ? "תזמון" : "Schedule"}
                            </Button>
                          ) : null}
                          <Link
                            aria-label={
                              he
                                ? `פתיחת ${item.reference}`
                                : `Open ${item.reference}`
                            }
                            href={`/field-service/cases/${item.id}`}
                          >
                            <ChevronRight aria-hidden="true" size={17} />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </Surface>
          )
        ) : view === "schedule" ? (
          <div className="field-service-schedule-grid">
            {appointments.length === 0 ? (
              <Surface className="field-service-grid-empty" level="raised">
                <EmptyState
                  title={he ? "אין ביקורים מתוזמנים" : "No scheduled visits"}
                  description={
                    he
                      ? "תזמון ידני עובד גם ללא חיבור ליומן חיצוני."
                      : "Manual scheduling works without an external calendar connection."
                  }
                />
              </Surface>
            ) : (
              appointments.map((item) => (
                <Surface as="article" key={item.id} level="raised">
                  <div>
                    <Badge
                      label={appointmentStatusLabel(item.status, he)}
                      tone={
                        item.status === "scheduled" ? "positive" : "neutral"
                      }
                    />
                    <span dir="ltr">{item.source}</span>
                  </div>
                  <h3 dir="auto">{item.technicianName}</h3>
                  <p>
                    <CalendarClock aria-hidden="true" size={15} />{" "}
                    {new Intl.DateTimeFormat(locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: item.timezone,
                    }).format(new Date(item.startsAt))}
                  </p>
                  <small dir="auto">
                    {item.notes ?? (he ? "ללא הערות" : "No scheduling notes")}
                  </small>
                  {canOperate &&
                  (item.status === "scheduled" ||
                    item.status === "suggested") ? (
                    <Button
                      onClick={() => openManageAppointmentDialog(item)}
                      size="small"
                      variant="secondary"
                    >
                      {he ? "ניהול תזמון" : "Manage schedule"}
                    </Button>
                  ) : null}
                </Surface>
              ))
            )}
          </div>
        ) : (
          <section className="field-service-technicians">
            <div className="field-service-section-heading">
              <div>
                <span className="eyebrow">
                  {he ? "צוות שטח" : "Field team"}
                </span>
                <h2>{he ? "טכנאים" : "Technicians"}</h2>
              </div>
              {canManage ? (
                <Button onClick={openTechnicianDialog} variant="secondary">
                  <Plus aria-hidden="true" size={16} />
                  {he ? "טכנאי חדש" : "New technician"}
                </Button>
              ) : null}
            </div>
            <div className="field-service-technician-grid">
              {technicians.length === 0 ? (
                <Surface className="field-service-grid-empty" level="raised">
                  <EmptyState
                    title={he ? "אין טכנאים" : "No technicians"}
                    description={
                      he
                        ? "הוסיפו פרופיל טכנאי לפני תזמון הביקור הראשון."
                        : "Add a technician profile before scheduling the first visit."
                    }
                  />
                </Surface>
              ) : (
                technicians.map((item) => (
                  <Surface as="article" key={item.id} level="raised">
                    <span className="field-service-metric__icon">
                      <UserRoundCog aria-hidden="true" size={19} />
                    </span>
                    <div>
                      <h3 dir="auto">{item.fullName}</h3>
                      <p dir="auto">
                        {item.employeeIdentifier ??
                          (he ? "ללא מזהה עובד" : "No employee ID")}
                      </p>
                      <small dir="auto">
                        {item.phone ??
                          item.email ??
                          (he ? "ללא פרטי קשר" : "No contact details")}
                      </small>
                    </div>
                    <div className="field-service-technician-actions">
                      <Badge
                        label={
                          item.active
                            ? technicianIdentityLabel(
                                item.identityVerification,
                                he,
                              )
                            : he
                              ? "לא פעיל"
                              : "Inactive"
                        }
                        tone={
                          item.active &&
                          item.identityVerification === "verified"
                            ? "positive"
                            : "neutral"
                        }
                      />
                      {canManage ? (
                        <Button
                          onClick={() => openEditTechnicianDialog(item)}
                          size="small"
                          type="button"
                          variant="quiet"
                        >
                          {he ? "עריכה" : "Edit"}
                        </Button>
                      ) : null}
                    </div>
                  </Surface>
                ))
              )}
            </div>
          </section>
        )}

        {view === "cases" && nextCaseCursor !== null ? (
          <div className="field-service-load-more">
            <Button
              busy={loadingCases}
              disabled={loadingCases}
              onClick={() =>
                void fetchCasePage({
                  append: true,
                  query: appliedQuery,
                  cursor: nextCaseCursor,
                })
              }
              variant="secondary"
            >
              {he ? "טעינת תיקים נוספים" : "Load more cases"}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        closeLabel={he ? "סגירה" : "Close"}
        onClose={closeCreateDialog}
        open={createOpen}
        title={he ? "תיק שירות חדש" : "New service case"}
      >
        <form
          className="field-service-form"
          onSubmit={(event) => void createCase(event)}
        >
          <DialogError message={error} />
          <div className="field-service-contact-search">
            <Input
              id="field-case-contact-search"
              label={he ? "חיפוש לקוח" : "Find customer"}
              onChange={(event) => setContactQuery(event.target.value)}
              value={contactQuery}
            />
            <Button
              disabled={loadingCases}
              onClick={() => void searchContactOptions()}
              type="button"
              variant="secondary"
            >
              <Search aria-hidden="true" size={14} />
              {he ? "חיפוש" : "Search"}
            </Button>
          </div>
          <Select
            id="field-case-customer"
            label={he ? "לקוח" : "Customer"}
            name="customerContactId"
            value={createCustomerId}
            onChange={(event) => setCreateCustomerId(event.target.value)}
            required
          >
            <option value="">{he ? "בחירת לקוח" : "Select customer"}</option>
            {contactOptions.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
                {contact.company ? ` · ${contact.company}` : ""}
              </option>
            ))}
          </Select>
          {serviceStores.length > 0 ? (
            <Select
              key={createCustomerId}
              id="field-case-store"
              name="serviceLocationId"
              label={he ? "רשת וסניף" : "Chain & store"}
            >
              <option value="">
                {he ? "בחירת סניף (לא חובה)" : "Choose a store (optional)"}
              </option>
              {serviceStores
                .filter(
                  (store) =>
                    store.contactId === null ||
                    store.contactId === createCustomerId,
                )
                .map((store) => (
                  <option key={store.id} value={store.id}>
                    {[store.chainName, store.name].filter(Boolean).join(" · ")}
                  </option>
                ))}
            </Select>
          ) : null}
          <Input
            id="field-case-title"
            label={he ? "כותרת" : "Case title"}
            name="title"
            required
          />
          <Textarea
            id="field-case-fault"
            label={he ? "תיאור התקלה" : "Fault description"}
            name="faultDescription"
            required
            rows={4}
          />
          <Textarea
            id="field-case-exact-failure"
            label={he ? "מה בדיוק לא עובד?" : "What exactly does not work?"}
            name="exactFailure"
            rows={2}
          />
          <Select
            defaultValue="unknown"
            id="field-case-warranty"
            label={he ? "אחריות" : "Warranty"}
            name="warrantyStatus"
          >
            <option value="unknown">{he ? "לא ידוע" : "Unknown"}</option>
            <option value="yes">{he ? "כן" : "Yes"}</option>
            <option value="no">{he ? "לא" : "No"}</option>
          </Select>
          <Input
            id="field-case-model"
            label={he ? "דגם (אופציונלי)" : "Product model (optional)"}
            name="productModel"
          />
          <Input
            id="field-case-serial"
            label={he ? "מספר סידורי (אופציונלי)" : "Serial number (optional)"}
            name="serialNumber"
          />
          <div className="field-service-form__actions">
            <Button onClick={closeCreateDialog} type="button" variant="quiet">
              {he ? "ביטול" : "Cancel"}
            </Button>
            <Button
              busy={pendingAction === "create-case"}
              disabled={pending}
              type="submit"
            >
              {pendingAction === "create-case"
                ? he
                  ? "יוצר…"
                  : "Creating…"
                : he
                  ? "יצירת תיק"
                  : "Create case"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        closeLabel={he ? "סגירה" : "Close"}
        {...(scheduleCase === undefined
          ? {}
          : {
              description: `${scheduleCase.reference} · ${scheduleCase.customerName}`,
            })}
        onClose={closeScheduleDialog}
        open={scheduleCase !== undefined}
        title={he ? "תזמון ביקור" : "Schedule visit"}
      >
        <form
          className="field-service-form"
          onSubmit={(event) => void schedule(event)}
        >
          <DialogError message={error} />
          <Select
            id="field-schedule-technician"
            label={he ? "טכנאי" : "Technician"}
            name="technicianId"
            required
          >
            <option value="">{he ? "בחירת טכנאי" : "Select technician"}</option>
            {technicians.map((technician) => (
              <option key={technician.id} value={technician.id}>
                {technician.fullName}
              </option>
            ))}
          </Select>
          <Input
            id="field-schedule-start"
            label={he ? "תאריך ושעה" : "Date & time"}
            name="startsAt"
            required
            type="datetime-local"
          />
          <Input
            defaultValue="60"
            id="field-schedule-duration"
            label={he ? "משך צפוי (דקות)" : "Expected duration (minutes)"}
            min="15"
            name="durationMinutes"
            required
            step="15"
            type="number"
          />
          <Textarea
            id="field-schedule-notes"
            label={he ? "הערות תזמון" : "Scheduling notes"}
            name="notes"
            rows={3}
          />
          <p className="field-service-form__hint">
            {he
              ? `אזור זמן: ${timezone}. הזמינות נבדקת שוב בעת השמירה.`
              : `Timezone: ${timezone}. Availability is checked again when saving.`}
          </p>
          {feature.aiSchedulingEnabled &&
          feature.readiness.calendarCanSuggest ? (
            <p className="field-service-form__hint">
              {he
                ? "הצעה אוטומטית מבוססת רק על יומן הדייר ונשמרת ללא יצירת אירוע עד לאישור מורשה."
                : "Automatic suggestions use only tenant-calendar availability and create no event before authorized approval."}
            </p>
          ) : null}
          <div className="field-service-form__actions">
            <Button onClick={closeScheduleDialog} type="button" variant="quiet">
              {he ? "ביטול" : "Cancel"}
            </Button>
            {feature.aiSchedulingEnabled &&
            feature.readiness.calendarCanSuggest ? (
              <Button
                busy={pendingAction === "suggest"}
                disabled={pending || technicians.length === 0}
                onClick={(event) => void suggestSchedule(event)}
                type="button"
                variant="secondary"
              >
                <Sparkles aria-hidden="true" size={15} />
                {he ? "הצעת המועד הבא" : "Suggest next available"}
              </Button>
            ) : null}
            <Button
              busy={pendingAction === "schedule"}
              disabled={pending || technicians.length === 0}
              type="submit"
            >
              {he ? "שמירת תזמון" : "Save schedule"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        closeLabel={he ? "סגירה" : "Close"}
        onClose={closeTechnicianDialog}
        open={technicianOpen}
        title={he ? "טכנאי חדש" : "New technician"}
      >
        <form
          className="field-service-form"
          onSubmit={(event) => void createTechnician(event)}
        >
          <DialogError message={error} />
          <Input
            id="field-tech-name"
            label={he ? "שם מלא" : "Full name"}
            name="fullName"
            required
          />
          <Input
            id="field-tech-id"
            label={he ? "מזהה טכנאי" : "Technician identifier"}
            name="employeeIdentifier"
          />
          <Input
            id="field-tech-phone"
            label={he ? "טלפון" : "Phone"}
            name="phone"
            type="tel"
          />
          <Input
            id="field-tech-email"
            label={he ? "אימייל" : "Email"}
            name="email"
            type="email"
          />
          <Select
            id="field-tech-user"
            label={he ? "חשבון טכנאי מקושר" : "Linked technician account"}
            name="linkedUserId"
          >
            <option value="">
              {he ? "ללא חשבון מקושר" : "No linked account"}
            </option>
            {technicianAccounts.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.displayName ?? member.email} · {member.email}
              </option>
            ))}
          </Select>
          <label className="field-service-check">
            <input name="verified" type="checkbox" value="true" />
            <span>
              {he
                ? "הזהות אומתה על ידי מנהל מורשה"
                : "Identity verified by an authorized manager"}
            </span>
          </label>
          <div className="field-service-form__actions">
            <Button
              onClick={closeTechnicianDialog}
              type="button"
              variant="quiet"
            >
              {he ? "ביטול" : "Cancel"}
            </Button>
            <Button
              busy={pendingAction === "create-technician"}
              disabled={pending}
              type="submit"
            >
              {he ? "הוספת טכנאי" : "Add technician"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        closeLabel={he ? "סגירה" : "Close"}
        onClose={closeEditTechnicianDialog}
        open={editingTechnician !== undefined}
        title={he ? "עריכת טכנאי" : "Edit technician"}
      >
        {editingTechnician === undefined ? null : (
          <form
            className="field-service-form"
            key={editingTechnician.id}
            onSubmit={(event) => void editTechnician(event)}
          >
            <DialogError message={error} />
            <Input
              defaultValue={editingTechnician.fullName}
              id="field-edit-tech-name"
              label={he ? "שם מלא" : "Full name"}
              name="fullName"
              required
            />
            <Input
              defaultValue={editingTechnician.employeeIdentifier ?? ""}
              id="field-edit-tech-id"
              label={he ? "מזהה טכנאי" : "Technician identifier"}
              name="employeeIdentifier"
            />
            <Input
              defaultValue={editingTechnician.phone ?? ""}
              id="field-edit-tech-phone"
              label={he ? "טלפון" : "Phone"}
              name="phone"
              type="tel"
            />
            <Input
              defaultValue={editingTechnician.email ?? ""}
              id="field-edit-tech-email"
              label={he ? "אימייל" : "Email"}
              name="email"
              type="email"
            />
            <Select
              defaultValue={editingTechnician.linkedUserId ?? ""}
              id="field-edit-tech-user"
              label={he ? "חשבון טכנאי מקושר" : "Linked technician account"}
              name="linkedUserId"
            >
              <option value="">
                {he ? "ללא חשבון מקושר" : "No linked account"}
              </option>
              {technicianAccounts.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.displayName ?? member.email} · {member.email}
                </option>
              ))}
            </Select>
            <label className="field-service-check">
              <input
                defaultChecked={
                  editingTechnician.identityVerification === "verified"
                }
                name="verified"
                type="checkbox"
                value="true"
              />
              <span>
                {he
                  ? "הזהות אומתה על ידי מנהל מורשה"
                  : "Identity verified by an authorized manager"}
              </span>
            </label>
            <label className="field-service-check">
              <input
                defaultChecked={editingTechnician.active}
                name="active"
                type="checkbox"
                value="true"
              />
              <span>{he ? "טכנאי פעיל" : "Active technician"}</span>
            </label>
            <p className="field-service-form__hint">
              {he
                ? "ביטול הסימון ישבית תזמונים חדשים וישמור את היסטוריית הביקורים."
                : "Deactivation blocks new scheduling and preserves visit history."}
            </p>
            <div className="field-service-form__actions">
              <Button
                onClick={closeEditTechnicianDialog}
                type="button"
                variant="quiet"
              >
                {he ? "ביטול" : "Cancel"}
              </Button>
              <Button
                busy={pendingAction === "edit-technician"}
                disabled={pending}
                type="submit"
              >
                {he ? "שמירת שינוי" : "Save changes"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      <Dialog
        closeLabel={he ? "סגירה" : "Close"}
        {...(manageAppointment === undefined
          ? {}
          : {
              description: `${manageAppointment.technicianName} · ${appointmentStatusLabel(manageAppointment.status, he)}`,
            })}
        onClose={closeManageAppointmentDialog}
        open={manageAppointment !== undefined}
        title={he ? "ניהול תזמון" : "Manage schedule"}
      >
        {manageAppointment === undefined ? null : (
          <form
            className="field-service-form"
            onSubmit={(event) => void changeAppointment(event)}
          >
            <DialogError message={error} />
            <Select
              defaultValue={manageAppointment.technicianId}
              id="field-reschedule-technician"
              label={he ? "טכנאי מוקצה" : "Assigned technician"}
              name="technicianId"
              required
            >
              {!technicians.some(
                (item) =>
                  item.id === manageAppointment.technicianId && item.active,
              ) ? (
                <option disabled value={manageAppointment.technicianId}>
                  {manageAppointment.technicianName} ·{" "}
                  {he ? "לא פעיל" : "inactive"}
                </option>
              ) : null}
              {technicians
                .filter((item) => item.active)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.fullName}
                  </option>
                ))}
            </Select>
            <Input
              defaultValue={dateTimeLocalInTimeZone(
                manageAppointment.startsAt,
                manageAppointment.timezone,
              )}
              id="field-reschedule-start"
              label={he ? "תאריך ושעה" : "Date & time"}
              name="startsAt"
              required
              type="datetime-local"
            />
            <Input
              defaultValue={String(
                Math.round(
                  (Date.parse(manageAppointment.endsAt) -
                    Date.parse(manageAppointment.startsAt)) /
                    60_000,
                ),
              )}
              id="field-reschedule-duration"
              label={he ? "משך צפוי (דקות)" : "Expected duration (minutes)"}
              max="1440"
              min="15"
              name="durationMinutes"
              required
              step="15"
              type="number"
            />
            <Textarea
              defaultValue={manageAppointment.notes ?? ""}
              id="field-reschedule-notes"
              label={he ? "הערות תזמון" : "Scheduling notes"}
              name="notes"
              rows={3}
            />
            {manageAppointment.externalEventId ? (
              <p className="field-service-form__hint">
                {he
                  ? "השינוי יעודכן גם ביומן הדייר. אם הסנכרון נכשל, התזמון לא ישתנה."
                  : "The tenant calendar will be updated in the same transaction. If synchronization fails, the appointment remains unchanged."}
              </p>
            ) : null}
            <div className="field-service-form__actions field-service-form__actions--spread">
              <Button
                busy={pendingAction === "cancel"}
                disabled={pending}
                onClick={() => void cancelAppointment()}
                type="button"
                variant="quiet"
              >
                {he ? "ביטול הביקור" : "Cancel appointment"}
              </Button>
              <span>
                {manageAppointment.status === "suggested" ? (
                  <Button
                    busy={pendingAction === "approve"}
                    disabled={pending || !feature.readiness.calendarCanBook}
                    onClick={() => void approveAppointment()}
                    type="button"
                    variant="secondary"
                  >
                    {he ? "אישור ההצעה" : "Approve suggestion"}
                  </Button>
                ) : null}
                <Button
                  busy={pendingAction === "reschedule"}
                  disabled={pending}
                  type="submit"
                >
                  {he ? "שמירת שינוי" : "Save change"}
                </Button>
              </span>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
