import type postgres from "postgres";
import { requireFieldService } from "./tenant-features.js";

export interface IncompleteServiceRequest {
  readonly id: string;
  readonly customerName: string;
  readonly recipient: string | null;
  readonly stage: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly waitingMinutes: number;
  readonly needsAttention: boolean;
  readonly delivery: string;
  readonly openedAt: string | null;
  readonly actions: readonly ("retry" | "new_request" | "close")[];
}

interface IntakeProgress {
  id: string;
  customer_name: string;
  recipient: string | null;
  followup_status: string;
  followup_error_safe: string | null;
  send_status: string | null;
  send_error: string | null;
  created_at: Date;
  updated_at: Date;
  requested_at: Date;
  first_opened_at: Date | null;
  expires_at: Date | null;
  consent: string;
  opted_out: boolean;
  attempt: number;
  now: Date;
  provider_message_id: string | null;
  can_manage: boolean;
}

export function incompleteRequest(
  row: IntakeProgress,
): IncompleteServiceRequest {
  const unknown =
    row.send_status === "sending" ||
    row.send_error === "delivery_outcome_unknown" ||
    row.followup_error_safe === "delivery_outcome_unknown";
  const expired = row.expires_at !== null && row.expires_at <= row.now;
  const blocked = row.consent !== "granted" || row.opted_out || !row.recipient;
  const sent = ["sent", "delivered", "read"].includes(row.send_status ?? "");
  const denied = row.consent !== "granted" || row.opted_out;
  const stage = unknown
    ? "uncertain"
    : expired
      ? "expired"
      : denied
        ? "blocked_consent"
        : row.first_opened_at
          ? "opened"
          : sent
            ? "awaiting_submission"
            : row.followup_status;
  const reasons: Record<string, string> = {
    uncertain: "תוצאת השליחה אינה ידועה. יש לבדוק מול הספק לפני שליחה נוספת.",
    expired: "תוקף הקישור פג.",
    blocked_consent: "נדרשים מספר מאומת והסכמה תקפה.",
    opened: "הטופס נפתח אך טרם הוגש.",
    awaiting_submission: "ההודעה נשלחה; פתיחת הטופס טרם נצפתה.",
    failed: "שליחת הקישור נכשלה.",
    blocked_window: "חלון ההודעות סגור ואין תבנית מאושרת זמינה.",
    no_channel: "אין ערוץ WhatsApp זמין לשליחה.",
    no_recipient: "אין מספר נמען מאומת.",
    recipient_conflict: "מספר הנמען מחייב בדיקת שיוך.",
    admitted: "הקישור בתור לשליחה; עדיין אין אישור ספק.",
  };
  const actions: ("retry" | "new_request" | "close")[] = row.can_manage
    ? ["close"]
    : [];
  if (row.can_manage && !unknown && !blocked && row.attempt < 3) {
    if (expired && !["queued", "sending"].includes(row.send_status ?? ""))
      actions.unshift("new_request");
    else if (
      !expired &&
      row.provider_message_id === null &&
      row.send_status === "failed" &&
      row.followup_status === "failed"
    )
      actions.unshift("retry");
  }
  const waitingMinutes = Math.max(
    0,
    Math.floor((row.now.valueOf() - row.requested_at.valueOf()) / 60000),
  );
  return {
    id: row.id,
    customerName: row.customer_name,
    recipient: row.recipient,
    stage,
    reason: reasons[stage] ?? "הבקשה ממתינה לשליחת קישור.",
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    waitingMinutes,
    needsAttention:
      waitingMinutes >= 15 &&
      ["requested", "queued", "failed"].includes(row.followup_status),
    delivery: row.send_status ?? "not_sent",
    openedAt: row.first_opened_at?.toISOString() ?? null,
    actions,
  };
}

export async function listIncompleteServiceRequests(
  sql: postgres.TransactionSql,
): Promise<readonly IncompleteServiceRequest[]> {
  await requireFieldService(sql);
  // Application-role RLS also excludes technicians and other tenants.
  const rows = await sql<IntakeProgress[]>`
    SELECT draft.id,contact.name AS customer_name,coalesce(identity.normalized_value,
      CASE WHEN request.id IS NULL THEN service.incomplete_intake_recipient(draft.id) END) AS recipient,
      draft.followup_status,draft.followup_error_safe,request.status AS send_status,request.last_error_code AS send_error,request.provider_message_id,
      service.can_manage_incomplete_intake() AS can_manage,
      draft.created_at,draft.updated_at,coalesce(draft.followup_requested_at,draft.created_at) AS requested_at,
      form.first_opened_at,form.expires_at,contact.whatsapp_consent AS consent,
      contact.whatsapp_opted_out_at IS NOT NULL AS opted_out,draft.followup_attempt AS attempt,clock_timestamp() AS now
    FROM service.intake_drafts draft
    JOIN crm.contacts contact ON contact.tenant_id=draft.tenant_id AND contact.id=draft.reporting_contact_id
    LEFT JOIN service.digital_intake_forms form ON form.tenant_id=draft.tenant_id AND form.intake_id=draft.id
    LEFT JOIN messaging.outbound_requests request ON request.tenant_id=draft.tenant_id AND request.message_id=draft.followup_message_id
    LEFT JOIN LATERAL (SELECT i.normalized_value FROM crm.contact_channel_identities i
      WHERE i.tenant_id=draft.tenant_id AND i.contact_id=contact.id AND i.channel='whatsapp' AND i.validation_status='valid' AND i.id=request.recipient_identity_id
        AND i.normalized_value=request.recipient_address
      ORDER BY i.is_primary DESC,i.id LIMIT 1) identity ON true
    WHERE draft.workflow_policy#>>'{whatsappFollowUp,mode}'='form' AND draft.followup_closed_at IS NULL
      AND draft.status IN ('collecting','awaiting_confirmation','expired') AND form.submitted_at IS NULL
      AND draft.followup_status<>'not_requested'
    ORDER BY draft.created_at ASC,draft.id LIMIT 200`;
  return rows.map(incompleteRequest);
}

export async function actOnIncompleteServiceRequest(
  sql: postgres.TransactionSql,
  intakeId: string,
  action: "retry" | "new_request" | "close",
  operationId: string,
): Promise<void> {
  await requireFieldService(sql);
  await sql`SELECT service.act_on_incomplete_intake(${intakeId}::uuid,${action},${operationId}::uuid)`;
}
