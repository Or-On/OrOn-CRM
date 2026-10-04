import type postgres from "postgres";

export type RemediationFlag =
  | "no_silence"
  | "audio_transcription"
  | "queue_priority"
  | "exclude_ai_memory"
  | "typing"
  | "session_memory"
  | "retrieval_fts"
  | "handoff_resume"
  | "debounce";

/** Absent flags remain off; callers already established transaction tenant. */
export async function remediationEnabled(
  transaction: postgres.TransactionSql,
  flag: RemediationFlag,
): Promise<boolean> {
  const rows = await transaction<{ enabled: boolean }[]>`
    SELECT enabled FROM platform.tenant_remediation_flags
    WHERE tenant_id=platform.current_tenant_id() AND flag_key=${flag}
  `;
  return rows[0]?.enabled === true;
}

/** Fixed wording acknowledges receipt without claiming an unperformed action. */
export function modelFailureReply(locale: string): string {
  return locale.startsWith("he")
    ? "קיבלתי את ההודעה. אבדוק ואחזור אליך."
    : "Got it. I will check and get back to you.";
}

/** A configured operator route owns its destination; model/job content cannot. */
export interface OperatorAlertProvider {
  deliver(request: {
    readonly idempotencyKey: string;
    readonly tenantId: string;
    readonly conversationId: string;
    readonly taskId: string;
    readonly reasonCode: "ai_model_failure";
  }): Promise<{ readonly reference: string }>;
}
