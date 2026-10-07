import type postgres from "postgres";
import { requireTenantFeature } from "./tenant-features.js";
import { closeTicket } from "./tickets.js";
import { transitionServiceCase } from "./field-service.js";

export const serviceInquiryStatuses = [
  "open",
  "scheduled",
  "telephone",
  "technician",
  "closed",
] as const;
export type ServiceInquiryStatus = (typeof serviceInquiryStatuses)[number];
export interface ServiceInquiry {
  readonly id: string;
  readonly reference: string;
  readonly customer: string;
  readonly location: string | null;
  readonly subject: string;
  readonly emergency?: boolean;
  readonly faultDescription: string | null;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly status: ServiceInquiryStatus;
  readonly caseId: string | null;
  readonly caseStatus: string | null;
  readonly technician: string | null;
  readonly appointmentAt: string | null;
  readonly appointmentEnd: string | null;
}
export interface ServiceInquiryPage {
  readonly inquiries: readonly ServiceInquiry[];
  readonly nextCursor: {
    readonly openedAt: string;
    readonly id: string;
  } | null;
}
export interface ServiceInquiryOptions {
  readonly id?: string;
  readonly status?: ServiceInquiryStatus | "all";
  readonly query?: string;
  readonly since?: string;
  readonly until?: string;
  readonly timezone: string;
  readonly beforeOpenedAt?: string;
  readonly beforeId?: string;
}

function uuid(value: string): string {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(value))
    throw new TypeError("Invalid inquiry identifier");
  return value;
}
function calendarDate(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new TypeError("Invalid inquiry date");
  return value;
}

/** One ticket per inquiry, including intake drafts that have no service case yet. */
export async function listServiceInquiries(
  sql: postgres.TransactionSql,
  options: ServiceInquiryOptions,
): Promise<ServiceInquiryPage> {
  await requireTenantFeature(sql, "tickets");
  await requireTenantFeature(sql, "field_service");
  const status = options.status ?? "all";
  if (status !== "all" && !serviceInquiryStatuses.includes(status))
    throw new TypeError("Invalid inquiry status");
  const query = options.query?.trim() ?? "";
  if (query.length > 200) throw new TypeError("Inquiry search is too long");
  const since = calendarDate(options.since);
  const until = calendarDate(options.until);
  if (since !== null && until !== null && since > until)
    throw new TypeError("Invalid inquiry date range");
  const id = options.id === undefined ? null : uuid(options.id);
  const cursorAt = options.beforeOpenedAt ?? null;
  const cursorId =
    options.beforeId === undefined ? null : uuid(options.beforeId);
  if (
    (cursorAt === null) !== (cursorId === null) ||
    (cursorAt !== null && !Number.isFinite(Date.parse(cursorAt)))
  )
    throw new TypeError("Invalid inquiry cursor");
  const rows = await sql<
    {
      id: string;
      reference: string;
      customer: string;
      location: string | null;
      subject: string;
      emergency: boolean;
      fault_description: string | null;
      opened_at: Date;
      cursor_opened_at: string;
      closed_at: Date | null;
      status: ServiceInquiryStatus;
      case_id: string | null;
      case_status: string | null;
      technician: string | null;
      appointment_at: Date | null;
      appointment_end: Date | null;
    }[]
  >`
    WITH inquiries AS (
      SELECT ticket.id, ticket.reference, contact.name AS customer, coalesce(location.name,draft.collected_fields->>'storeName',draft.collected_fields->>'serviceAddress') AS location,
        ticket.subject, ticket.emergency_at IS NOT NULL AS emergency,
        coalesce(service_case.fault_description, draft.collected_fields->>'faultDescription') AS fault_description,
        ticket.opened_at, ticket.closed_at, ticket.service_case_id AS case_id,
        service_case.status AS case_status, coalesce(appointment.technician,assigned_technician.full_name) AS technician,
        appointment.starts_at AS appointment_at, appointment.ends_at AS appointment_end,
        CASE WHEN ticket.status='closed' THEN
          CASE WHEN closure.evidence->>'serviceResolutionMethod' IN ('telephone','technician')
            THEN closure.evidence->>'serviceResolutionMethod' ELSE 'closed' END
          WHEN appointment.status IN ('scheduled','in_progress') THEN 'scheduled' ELSE 'open' END AS status
      FROM support.tickets ticket
      JOIN crm.contacts contact ON contact.tenant_id=ticket.tenant_id AND contact.id=ticket.contact_id
      LEFT JOIN service.cases service_case ON service_case.tenant_id=ticket.tenant_id AND service_case.id=ticket.service_case_id
      LEFT JOIN crm.service_locations location ON location.tenant_id=service_case.tenant_id AND location.id=service_case.service_location_id
      LEFT JOIN service.intake_drafts draft ON draft.tenant_id=ticket.tenant_id AND draft.id=ticket.intake_draft_id
      LEFT JOIN service.technicians assigned_technician ON assigned_technician.tenant_id=service_case.tenant_id AND assigned_technician.id=service_case.assigned_technician_id
      LEFT JOIN LATERAL (
        SELECT item.starts_at,item.ends_at,item.status,technician.full_name AS technician
        FROM service.appointments item
        JOIN service.technicians technician ON technician.tenant_id=item.tenant_id AND technician.id=item.technician_id
        WHERE item.tenant_id=ticket.tenant_id AND item.case_id=ticket.service_case_id
          AND item.status IN ('scheduled','in_progress','completed')
        ORDER BY CASE WHEN item.status='completed' THEN 1 ELSE 0 END,
          CASE WHEN item.status='completed' THEN item.starts_at END DESC,item.starts_at,item.id LIMIT 1
      ) appointment ON true
      LEFT JOIN LATERAL (
        SELECT event.evidence FROM support.ticket_events event
        WHERE event.tenant_id=ticket.tenant_id AND event.ticket_id=ticket.id AND event.kind='status_change'
        ORDER BY event.sequence DESC LIMIT 1
      ) closure ON true
      WHERE ticket.tenant_id=platform.current_tenant_id()
        AND (${id}::uuid IS NULL OR ticket.id=${id}::uuid)
    )
    SELECT *,to_char(opened_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_opened_at FROM inquiries
    WHERE (${status}='all' OR status=${status})
      AND (${query}='' OR reference ILIKE '%' || ${query} || '%'
        OR subject ILIKE '%' || ${query} || '%' OR customer ILIKE '%' || ${query} || '%'
        OR location ILIKE '%' || ${query} || '%')
      AND (${since}::date IS NULL OR opened_at >= (${since}::date::timestamp AT TIME ZONE ${options.timezone}))
      AND (${until}::date IS NULL OR opened_at < ((${until}::date + 1)::timestamp AT TIME ZONE ${options.timezone}))
      AND (${cursorAt}::text::timestamptz IS NULL OR (opened_at,id)<(${cursorAt}::text::timestamptz,${cursorId}::uuid))
    ORDER BY opened_at DESC,id DESC LIMIT 26
  `;
  const inquiries = rows.slice(0, 25).map((row): ServiceInquiry => ({
    id: row.id,
    reference: row.reference,
    customer: row.customer,
    location: row.location,
    subject: row.subject,
    emergency: row.emergency,
    faultDescription: row.fault_description,
    status: row.status,
    openedAt: row.opened_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
    caseId: row.case_id,
    caseStatus: row.case_status,
    technician: row.technician,
    appointmentAt: row.appointment_at?.toISOString() ?? null,
    appointmentEnd: row.appointment_end?.toISOString() ?? null,
  }));
  // Date truncates PostgreSQL's microseconds; preserve them in the keyset cursor.
  const last = rows.slice(0, 25).at(-1);
  return {
    inquiries,
    nextCursor:
      rows.length > 25 && last !== undefined
        ? { openedAt: last.cursor_opened_at, id: last.id }
        : null,
  };
}

export type ServiceOverviewPeriod = "today" | "week" | "month";
export interface ServiceManagerMetrics {
  readonly incomingCalls: number;
  readonly incomingMessages: number;
  readonly awaitingForms?: number;
  readonly waitingForHuman?: number;
  readonly opened: number;
  readonly closed: number;
  readonly since: string;
  readonly until: string;
}
/** Full tenant-visible aggregates, using local calendar boundaries and closure dates. */
export async function serviceManagerMetrics(
  sql: postgres.TransactionSql,
  timezone: string,
  period: ServiceOverviewPeriod,
): Promise<ServiceManagerMetrics> {
  await requireTenantFeature(sql, "tickets");
  await requireTenantFeature(sql, "field_service");
  if (!["today", "week", "month"].includes(period))
    throw new TypeError("Invalid overview period");
  const rows = await sql<ServiceManagerMetrics[]>`
    WITH local_time AS (SELECT statement_timestamp() AT TIME ZONE ${timezone} AS now),
    period AS (SELECT
      (CASE ${period} WHEN 'today' THEN date_trunc('day',now)
        WHEN 'week' THEN date_trunc('day',now)-interval '6 days'
        ELSE date_trunc('month',now) END AT TIME ZONE ${timezone}) AS start,
      statement_timestamp() AS finish FROM local_time)
    SELECT
      (SELECT count(*)::int FROM service.intake_drafts WHERE tenant_id=platform.current_tenant_id()
        AND status IN ('collecting','awaiting_confirmation')
        AND workflow_policy#>>'{whatsappFollowUp,mode}'='form') AS "awaitingForms",
      (SELECT count(*)::int FROM messaging.conversations WHERE tenant_id=platform.current_tenant_id()
        AND ownership_mode='human' AND handoff_reason_safe IS NOT NULL
        AND status IN ('open','pending') AND removed_from_inbox_at IS NULL) AS "waitingForHuman",
      (SELECT count(*)::int FROM public.sessions,period WHERE tenant_id=platform.current_tenant_id()
        AND direction='inbound' AND created_at>=period.start AND created_at<=period.finish) AS "incomingCalls",
      (SELECT count(*)::int FROM messaging.messages,period WHERE tenant_id=platform.current_tenant_id()
        AND direction='inbound' AND created_at>=period.start AND created_at<=period.finish) AS "incomingMessages",
      (SELECT count(*)::int FROM support.tickets,period WHERE tenant_id=platform.current_tenant_id()
        AND opened_at>=period.start AND opened_at<=period.finish) AS opened,
      (SELECT count(*)::int FROM support.tickets,period WHERE tenant_id=platform.current_tenant_id()
        AND status='closed' AND closed_at>=period.start AND closed_at<=period.finish) AS closed,
      to_char(period.start AT TIME ZONE ${timezone},'YYYY-MM-DD') AS since,
      to_char(period.finish AT TIME ZONE ${timezone},'YYYY-MM-DD') AS until FROM period
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("Service overview unavailable");
  return row;
}

/** Uses the existing closure and case transitions; never equates a call ending with resolution. */
export async function resolveServiceInquiry(
  sql: postgres.TransactionSql,
  userId: string,
  input: {
    readonly ticketId: string;
    readonly method: "telephone" | "technician";
    readonly confirmation: "customer" | "authoritative_evidence";
    readonly summary: string;
  },
): Promise<void> {
  await requireTenantFeature(sql, "tickets");
  await requireTenantFeature(sql, "field_service");
  const id = uuid(input.ticketId);
  if (
    !["telephone", "technician"].includes(input.method) ||
    !["customer", "authoritative_evidence"].includes(input.confirmation)
  )
    throw new TypeError("Select a resolution method and confirmation");
  if (!input.summary.trim() || input.summary.length > 1000)
    throw new TypeError("Enter a resolution summary");
  const tickets = await sql<
    { status: string; service_case_id: string | null }[]
  >`
    SELECT status,service_case_id FROM support.tickets WHERE tenant_id=platform.current_tenant_id() AND id=${id}::uuid FOR UPDATE
  `;
  const ticket = tickets[0];
  if (ticket?.status !== "open")
    throw new TypeError("Inquiry is unavailable or already closed");
  if (input.method === "technician" && ticket.service_case_id === null)
    throw new TypeError("A completed technician service case is required");
  if (ticket.service_case_id !== null) {
    const cases = await sql<
      { status: string }[]
    >`SELECT status FROM service.cases WHERE tenant_id=platform.current_tenant_id() AND id=${ticket.service_case_id}::uuid FOR UPDATE`;
    const current = cases[0];
    if (current === undefined)
      throw new TypeError("Service case is unavailable");
    if (input.method === "technician") {
      if (!["completed", "closed"].includes(current.status))
        throw new TypeError(
          "Complete the technician work before closing the inquiry",
        );
      if (current.status === "completed")
        await transitionServiceCase(
          sql,
          { userId },
          ticket.service_case_id,
          "closed",
          input.summary,
        );
    } else {
      const work = await sql<{ active: boolean }[]>`SELECT (
        EXISTS(SELECT 1 FROM service.appointments WHERE tenant_id=platform.current_tenant_id() AND case_id=${ticket.service_case_id}::uuid AND status IN ('scheduled','in_progress','suggested')) OR
        EXISTS(SELECT 1 FROM service.visits WHERE tenant_id=platform.current_tenant_id() AND case_id=${ticket.service_case_id}::uuid AND status NOT IN ('cancelled','reported'))
      ) AS active`;
      if (
        work[0]?.active ||
        !["awaiting_scheduling", "cancelled"].includes(current.status)
      )
        throw new TypeError(
          "Cancel pending field work before recording telephone resolution",
        );
      if (current.status === "awaiting_scheduling")
        await transitionServiceCase(
          sql,
          { userId },
          ticket.service_case_id,
          "cancelled",
          input.summary,
        );
    }
  }
  await closeTicket(sql, userId, {
    ticketId: id,
    closureReason: "resolved",
    resolutionClassification: "resolved",
    resolutionConfirmedBy: input.confirmation,
    summarySafe: input.summary,
    serviceResolutionMethod: input.method,
  });
}
