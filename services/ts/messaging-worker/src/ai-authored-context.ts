import type { TransactionSql } from "postgres";

/** Receipts count only after the database stamps a fresh worker claim. Unmarked
 * historical notes remain unknown; authors and business text are never proof. */
export async function loadAiAuthoredContextIds(
  sql: TransactionSql,
  trustedTenantId: string,
  candidates: {
    readonly noteIds: readonly string[];
    readonly taskIds: readonly string[];
  },
): Promise<{
  readonly noteIds: readonly string[];
  readonly taskIds: readonly string[];
}> {
  const identity = await sql<
    { allowed: boolean }[]
  >`SELECT platform.current_tenant_id()=${trustedTenantId}::uuid AS allowed`;
  if (identity[0]?.allowed !== true)
    throw new Error("AI context tenant mismatch");
  if (candidates.noteIds.length > 64 || candidates.taskIds.length > 64)
    throw new Error("AI context candidate limit exceeded");
  if (candidates.noteIds.length === 0 && candidates.taskIds.length === 0)
    return { noteIds: [], taskIds: [] };
  const flags = await sql<
    { enabled: boolean }[]
  >`SELECT enabled FROM platform.tenant_remediation_flags WHERE tenant_id=${trustedTenantId}::uuid AND flag_key='exclude_ai_memory'`;
  if (flags[0]?.enabled !== true) return { noteIds: [], taskIds: [] };
  const receipts = await sql<
    { note_id: string | null; task_id: string | null }[]
  >`
    SELECT metadata->>'noteId' AS note_id, metadata->>'taskId' AS task_id
    FROM audit.records
    WHERE tenant_id=${trustedTenantId}::uuid
      AND metadata->>'aiContextProvenance'='worker_verified_v1'
      AND action IN ('conversation.ai_handoff_ticket','conversation.ai_model_failure')
      AND (metadata->>'noteId'=ANY(${[...candidates.noteIds]}::text[])
        OR metadata->>'taskId'=ANY(${[...candidates.taskIds]}::text[]))
  `;
  const valid = (id: string | null): id is string =>
    id !== null &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id);
  return {
    noteIds: [
      ...new Set(
        receipts
          .map((row) => row.note_id)
          .filter(valid)
          .filter((id) => candidates.noteIds.includes(id)),
      ),
    ],
    taskIds: [
      ...new Set(
        receipts
          .map((row) => row.task_id)
          .filter(valid)
          .filter((id) => candidates.taskIds.includes(id)),
      ),
    ],
  };
}
