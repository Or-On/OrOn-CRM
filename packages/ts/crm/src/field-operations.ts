/**
 * Configured field operations: red calls, phone-inquiry follow-up, reply
 * linking and the technician's explicit visit timeline.
 *
 * PostgreSQL owns every authorization, workflow and evidence decision; this
 * module is a typed boundary around those functions and never re-implements
 * a gate in application code.
 */
import type postgres from "postgres";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function identifier(value: string, name: string): string {
  if (!uuidPattern.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

/** A workflow requirement the caller must satisfy before retrying. */
export class FieldWorkflowRequirementError extends Error {
  readonly code: FieldWorkflowRequirement;
  readonly messages: { readonly he: string; readonly en: string };

  constructor(code: FieldWorkflowRequirement) {
    const messages = requirementMessages[code];
    super(messages.en);
    this.name = "FieldWorkflowRequirementError";
    this.code = code;
    this.messages = messages;
  }
}

export type FieldWorkflowRequirement =
  | "BEFORE_PHOTO_REQUIRED"
  | "AFTER_PHOTO_REQUIRED"
  | "ARRIVAL_REQUIRED"
  | "WORK_START_REQUIRED"
  | "PREPARATION_ACKNOWLEDGEMENT_REQUIRED"
  | "PREPARATION_CHECKLIST_INCOMPLETE"
  | "PREPARATION_REQUIREMENTS_CHANGED";

const requirementMessages: Readonly<
  Record<FieldWorkflowRequirement, { readonly he: string; readonly en: string }>
> = {
  BEFORE_PHOTO_REQUIRED: {
    he: 'יש להעלות לפחות תמונת "לפני" אחת של הביקור לפני תחילת העבודה.',
    en: 'Upload at least one "before" photo for this visit before starting work.',
  },
  AFTER_PHOTO_REQUIRED: {
    he: 'יש להעלות לפחות תמונת "אחרי" אחת של הביקור לפני סיום העבודה או סגירת הדוח.',
    en: 'Upload at least one "after" photo for this visit before completing the work or finalizing the report.',
  },
  ARRIVAL_REQUIRED: {
    he: "יש לרשום הגעה לאתר (חתימת הגעה) לפני תחילת העבודה.",
    en: "Record arrival on site (arrival signature) before starting work.",
  },
  WORK_START_REQUIRED: {
    he: "יש לרשום תחילת עבודה לפני סיום העבודה.",
    en: "Record the start of work before completing it.",
  },
  PREPARATION_ACKNOWLEDGEMENT_REQUIRED: {
    he: "יש לאשר את ההצטיידות לקריאה לפני היציאה לדרך.",
    en: "Confirm the preparation for this call before departing.",
  },
  PREPARATION_CHECKLIST_INCOMPLETE: {
    he: "יש לסמן את כל פריטי החובה ברשימת ההצטיידות.",
    en: "Tick every required preparation item.",
  },
  PREPARATION_REQUIREMENTS_CHANGED: {
    he: "דרישות ההצטיידות השתנו. יש לעבור עליהן שוב.",
    en: "The preparation requirements changed. Review them again.",
  },
};

/** Map a database gate to its typed requirement; other errors pass through. */
export function fieldWorkflowRequirement(
  error: unknown,
): FieldWorkflowRequirementError | undefined {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : "";
  const code = (
    Object.keys(requirementMessages) as FieldWorkflowRequirement[]
  ).find((candidate) => message === candidate);
  return code === undefined
    ? undefined
    : new FieldWorkflowRequirementError(code);
}

async function gate<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw fieldWorkflowRequirement(error) ?? error;
  }
}

// --- red calls ----------------------------------------------------------------

export interface EmergencyReceipt {
  readonly ticketId: string;
  readonly created: boolean;
}

/**
 * Mark an existing inquiry as the tenant's emergency ("red call"). Requires an
 * owner/admin/dispatcher and the tenant's manual red-call setting; audited.
 */
export async function markTicketEmergency(
  sql: postgres.TransactionSql,
  ticketId: string,
  reason: string,
): Promise<EmergencyReceipt> {
  const normalized = reason.replace(/\s+/gu, " ").trim();
  if (normalized.length < 1 || normalized.length > 500)
    throw new TypeError("Describe the urgency in 1-500 characters");
  const rows = await sql<{ receipt: EmergencyReceipt }[]>`
    SELECT support.mark_ticket_emergency(
      ${identifier(ticketId, "Inquiry")}::uuid, ${normalized}, 'manual'
    ) AS receipt
  `;
  const receipt = rows[0]?.receipt;
  if (receipt === undefined)
    throw new Error("Emergency marking returned no receipt");
  return receipt;
}

// --- phone inquiry details ------------------------------------------------------

export interface InquiryMessage {
  readonly messageId: string;
  readonly direction: "inbound" | "outbound";
  readonly contentType: string;
  readonly text: string | null;
  readonly hasMedia: boolean;
  readonly status: string;
  readonly at: string;
}

export interface InquiryReplyToLink {
  readonly messageId: string;
  readonly contentType: string;
  readonly text: string | null;
  readonly at: string;
  readonly candidates: readonly {
    readonly intakeId: string;
    readonly reference: string | null;
  }[];
}

export interface InquiryDetail {
  readonly intakeId: string;
  readonly status: string;
  readonly source: "voice" | "whatsapp";
  readonly fields: Readonly<Record<string, string>>;
  readonly missingFields: readonly string[];
  readonly followupStatus: string;
  readonly followupError: string | null;
  readonly customerRepliedAt: string | null;
  readonly customerMediaReceivedAt: string | null;
  readonly messages: readonly InquiryMessage[];
  readonly repliesToLink: readonly InquiryReplyToLink[];
}

/** The intake behind an inquiry: captured details, follow-up and replies. */
export async function getInquiryDetail(
  sql: postgres.TransactionSql,
  ticketId: string,
): Promise<InquiryDetail | undefined> {
  const id = identifier(ticketId, "Inquiry");
  const drafts = await sql<
    {
      id: string;
      status: string;
      source_session_id: string | null;
      collected_fields: Record<string, unknown>;
      workflow_policy: unknown;
      followup_status: string;
      followup_error_safe: string | null;
      customer_replied_at: Date | null;
      customer_media_received_at: Date | null;
      missing: string[];
    }[]
  >`
    SELECT draft.id, draft.status, draft.source_session_id, draft.collected_fields,
      draft.workflow_policy, draft.followup_status, draft.followup_error_safe,
      draft.customer_replied_at, draft.customer_media_received_at,
      ARRAY(SELECT jsonb_array_elements_text(service.intake_missing_fields(
        draft.collected_fields, coalesce(draft.workflow_policy, service.current_workflow_policy())))) AS missing
    FROM support.tickets ticket
    JOIN service.intake_drafts draft
      ON draft.tenant_id = ticket.tenant_id AND draft.id = ticket.intake_draft_id
    WHERE ticket.tenant_id = platform.current_tenant_id() AND ticket.id = ${id}::uuid
  `;
  const draft = drafts[0];
  if (draft === undefined) return undefined;
  const messages = await sql<
    {
      id: string;
      direction: "inbound" | "outbound";
      content_type: string;
      content_text: string | null;
      object_id: string | null;
      status: string;
      created_at: Date;
    }[]
  >`
    SELECT message.id, message.direction, message.content_type, message.content_text,
      message.object_id, message.status, message.created_at
    FROM service.intake_messages link
    JOIN messaging.messages message
      ON message.tenant_id = link.tenant_id AND message.id = link.message_id
    WHERE link.tenant_id = platform.current_tenant_id()
      AND link.intake_draft_id = ${draft.id}::uuid
    ORDER BY message.created_at, message.id
    LIMIT 200
  `;
  const triage = await sql<
    {
      message_id: string;
      content_type: string;
      content_text: string | null;
      created_at: Date;
      candidates: { intakeId: string; reference: string | null }[];
    }[]
  >`
    SELECT triage.message_id, message.content_type, message.content_text, message.created_at,
      (SELECT jsonb_agg(jsonb_build_object('intakeId', candidate,
          'reference', (SELECT reference FROM support.tickets other
            WHERE other.tenant_id = triage.tenant_id AND other.intake_draft_id = candidate)))
        FROM unnest(triage.candidate_intake_ids) candidate) AS candidates
    FROM service.followup_triage triage
    JOIN messaging.messages message
      ON message.tenant_id = triage.tenant_id AND message.id = triage.message_id
    WHERE triage.tenant_id = platform.current_tenant_id() AND triage.resolved_at IS NULL
      AND ${draft.id}::uuid = ANY(triage.candidate_intake_ids)
    ORDER BY message.created_at
    LIMIT 50
  `;
  const fields = Object.fromEntries(
    Object.entries(draft.collected_fields)
      .filter(
        ([key, value]) =>
          typeof value === "string" && !["nationalId", "storeId"].includes(key),
      )
      .map(([key, value]) => [key, value as string]),
  );
  return {
    intakeId: draft.id,
    status: draft.status,
    source: draft.source_session_id === null ? "whatsapp" : "voice",
    fields,
    missingFields: draft.missing,
    followupStatus: draft.followup_status,
    followupError: draft.followup_error_safe,
    customerRepliedAt: draft.customer_replied_at?.toISOString() ?? null,
    customerMediaReceivedAt:
      draft.customer_media_received_at?.toISOString() ?? null,
    messages: messages.map((message) => ({
      messageId: message.id,
      direction: message.direction,
      contentType: message.content_type,
      text: message.content_text,
      hasMedia: message.object_id !== null,
      status: message.status,
      at: message.created_at.toISOString(),
    })),
    repliesToLink: triage.map((row) => ({
      messageId: row.message_id,
      contentType: row.content_type,
      text: row.content_text,
      at: row.created_at.toISOString(),
      candidates: row.candidates,
    })),
  };
}

/** Link a held customer reply to one of its candidate inquiries (audited). */
export async function linkCustomerReply(
  sql: postgres.TransactionSql,
  messageId: string,
  intakeId: string,
): Promise<void> {
  await sql`
    SELECT service.resolve_followup_triage(
      ${identifier(messageId, "Message")}::uuid, ${identifier(intakeId, "Inquiry")}::uuid
    )
  `;
}

// --- technician visit timeline ------------------------------------------------------

export type VisitEvent = "en_route" | "work_started" | "work_completed";

export interface VisitTimes {
  readonly visitId: string;
  readonly enRouteAt: string | null;
  readonly arrivalAt: string | null;
  readonly workStartedAt: string | null;
  readonly workCompletedAt: string | null;
  readonly departureAt: string | null;
  readonly changed: boolean;
}

/** Record an explicit technician event; the server clock is the event time. */
export async function recordVisitEvent(
  sql: postgres.TransactionSql,
  visitId: string,
  event: VisitEvent,
  requestId: string,
): Promise<VisitTimes> {
  if (!["en_route", "work_started", "work_completed"].includes(event))
    throw new TypeError("Unsupported visit event");
  return gate(async () => {
    const rows = await sql<{ times: VisitTimes }[]>`
      SELECT service.record_visit_event(
        ${identifier(visitId, "Visit")}::uuid, ${event}, ${requestId.slice(0, 200)}
      ) AS times
    `;
    const times = rows[0]?.times;
    if (times === undefined) throw new Error("Visit event returned no receipt");
    return times;
  });
}

export type CorrectableVisitTime =
  | "en_route_at"
  | "arrival_at"
  | "work_started_at"
  | "work_completed_at"
  | "departure_at";

/** Owner/administrator correction that keeps the previous value and reason. */
export async function correctVisitTime(
  sql: postgres.TransactionSql,
  input: {
    readonly visitId: string;
    readonly field: CorrectableVisitTime;
    readonly value: string;
    readonly reason: string;
  },
): Promise<string> {
  const value = new Date(input.value);
  if (!Number.isFinite(value.getTime()))
    throw new TypeError("Enter a valid date and time");
  const rows = await sql<{ id: string }[]>`
    SELECT service.correct_visit_time(
      ${identifier(input.visitId, "Visit")}::uuid, ${input.field}, ${value}::timestamptz,
      ${input.reason}
    ) AS id
  `;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("Correction returned no receipt");
  return id;
}

export interface VisitTimeline {
  readonly visitId: string;
  readonly timezone: string;
  readonly scheduledStart: string | null;
  readonly scheduledEnd: string | null;
  readonly enRouteAt: string | null;
  readonly arrivalAt: string | null;
  readonly workStartedAt: string | null;
  readonly workCompletedAt: string | null;
  readonly departureAt: string | null;
  readonly corrections: readonly {
    readonly field: CorrectableVisitTime;
    readonly previousValue: string | null;
    readonly newValue: string;
    readonly reason: string;
    readonly correctedAt: string;
  }[];
}

/** Scheduled window and actual events, with the tenant time zone for display. */
export async function getVisitTimeline(
  sql: postgres.TransactionSql,
  visitId: string,
): Promise<VisitTimeline | undefined> {
  const id = identifier(visitId, "Visit");
  const rows = await sql<
    {
      id: string;
      timezone: string;
      starts_at: Date | null;
      ends_at: Date | null;
      en_route_at: Date | null;
      arrival_at: Date | null;
      work_started_at: Date | null;
      work_completed_at: Date | null;
      departure_at: Date | null;
    }[]
  >`
    SELECT visit.id,
      coalesce(appointment.timezone, (SELECT timezone FROM crm.tenant_settings
        WHERE tenant_id = platform.current_tenant_id()), 'UTC') AS timezone,
      appointment.starts_at, appointment.ends_at, visit.en_route_at, visit.arrival_at,
      visit.work_started_at, visit.work_completed_at, visit.departure_at
    FROM service.visits visit
    LEFT JOIN service.appointments appointment
      ON appointment.tenant_id = visit.tenant_id AND appointment.id = visit.appointment_id
    WHERE visit.tenant_id = platform.current_tenant_id() AND visit.id = ${id}::uuid
  `;
  const row = rows[0];
  if (row === undefined) return undefined;
  const corrections = await sql<
    {
      field: CorrectableVisitTime;
      previous_value: Date | null;
      new_value: Date;
      reason: string;
      corrected_at: Date;
    }[]
  >`
    SELECT field, previous_value, new_value, reason, corrected_at
    FROM service.visit_time_corrections
    WHERE tenant_id = platform.current_tenant_id() AND visit_id = ${id}::uuid
    ORDER BY corrected_at
  `;
  const iso = (value: Date | null) => value?.toISOString() ?? null;
  return {
    visitId: row.id,
    timezone: row.timezone,
    scheduledStart: iso(row.starts_at),
    scheduledEnd: iso(row.ends_at),
    enRouteAt: iso(row.en_route_at),
    arrivalAt: iso(row.arrival_at),
    workStartedAt: iso(row.work_started_at),
    workCompletedAt: iso(row.work_completed_at),
    departureAt: iso(row.departure_at),
    corrections: corrections.map((correction) => ({
      field: correction.field,
      previousValue: iso(correction.previous_value),
      newValue: correction.new_value.toISOString(),
      reason: correction.reason,
      correctedAt: correction.corrected_at.toISOString(),
    })),
  };
}

// --- preparation ----------------------------------------------------------------------

export interface VisitPreparation {
  readonly enabled: boolean;
  readonly requirementsHash?: string;
  readonly summary?: Readonly<Record<string, string | null>>;
  readonly checklist?: readonly {
    readonly key: string;
    readonly label: string;
    readonly required: boolean;
  }[];
  readonly instructions?: string | null;
  readonly requireAcknowledgement?: boolean;
  readonly acknowledged?: boolean;
  readonly acknowledgedAt?: string | null;
  readonly checkedItems?: readonly string[];
}

export async function getVisitPreparation(
  sql: postgres.TransactionSql,
  visitId: string,
): Promise<VisitPreparation> {
  const rows = await sql<{ preparation: VisitPreparation }[]>`
    SELECT service.visit_preparation(${identifier(visitId, "Visit")}::uuid) AS preparation
  `;
  return rows[0]?.preparation ?? { enabled: false };
}

export async function acknowledgeVisitPreparation(
  sql: postgres.TransactionSql,
  input: {
    readonly visitId: string;
    readonly requirementsHash: string;
    readonly checkedItems: readonly string[];
  },
): Promise<VisitPreparation> {
  if (!/^[0-9a-f]{32}$/u.test(input.requirementsHash))
    throw new TypeError("Preparation requirements are invalid; reload them");
  if (
    input.checkedItems.length > 30 ||
    input.checkedItems.some((item) => !/^[a-z0-9_]{1,40}$/u.test(item))
  )
    throw new TypeError("Invalid checklist selection");
  return gate(async () => {
    const rows = await sql<{ preparation: VisitPreparation }[]>`
      SELECT service.acknowledge_visit_preparation(
        ${identifier(input.visitId, "Visit")}::uuid, ${input.requirementsHash},
        ${sql.json([...input.checkedItems])}
      ) AS preparation
    `;
    const preparation = rows[0]?.preparation;
    if (preparation === undefined)
      throw new Error("Preparation was not recorded");
    return preparation;
  });
}

/** Wrap a status/finalization call so its evidence gate becomes a typed error. */
export function withFieldWorkflowGates<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return gate(operation);
}
