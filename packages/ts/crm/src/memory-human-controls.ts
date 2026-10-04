import type postgres from "postgres";

/** Human correction is a separate immutable audited assertion. The canonical
 * source customer statement is retained; SQL resolves fresh human authority.
 */
export async function correctCustomerMemoryFact(
  sql: postgres.TransactionSql,
  input: {
    readonly contactId: string;
    readonly factId: string;
    readonly value: string | null;
    readonly reason: string;
  },
): Promise<string | null> {
  if (
    typeof input.reason !== "string" ||
    !input.reason.trim() ||
    input.reason.length > 1000 ||
    (input.value !== null &&
      (typeof input.value !== "string" ||
        !input.value.trim() ||
        input.value.length > 1000))
  )
    throw new TypeError("invalid memory correction");
  const rows = await sql<{ id: string }[]>`
    SELECT agents.correct_customer_memory_fact(f.id,${input.value},${input.reason}) id
    FROM agents.customer_memory_facts f
    JOIN agents.messaging_memory_sessions session ON session.id=f.session_id AND session.tenant_id=f.tenant_id
    JOIN messaging.conversations conversation ON conversation.id=session.conversation_id AND conversation.tenant_id=session.tenant_id
    WHERE f.id=${input.factId}::uuid AND f.tenant_id=platform.current_tenant_id()
      AND conversation.contact_id=${input.contactId}::uuid
  `;
  return rows[0]?.id ?? null;
}

export async function reviewedMemoryActive(
  sql: postgres.TransactionSql,
): Promise<boolean> {
  const rows = await sql<
    { active: boolean }[]
  >`SELECT agents.reviewed_memory_active() active`;
  return rows[0]?.active === true;
}

export async function readSessionMemoryCorrections(
  sql: postgres.TransactionSql,
  sessionId: string,
  agentVersionId: string,
): Promise<
  readonly {
    id: string;
    fact_key: string;
    fact_value: string | null;
    operation: "correct" | "delete";
  }[]
> {
  return sql`SELECT * FROM agents.read_session_memory_corrections(${sessionId}::uuid,${agentVersionId}::uuid)`;
}

/** This reader suppresses obsolete memory even when reuse is disabled.
 * Authority comes from fresh canonical conversation/Agent/human controls.
 */
export async function readConversationMemoryCorrections(
  sql: postgres.TransactionSql,
  conversationId: string,
  agentVersionId: string,
): ReturnType<typeof readSessionMemoryCorrections> {
  return sql`SELECT * FROM agents.read_conversation_memory_corrections(${conversationId}::uuid,${agentVersionId}::uuid)`;
}

/** Cross-channel summaries remain untrusted context. SQL requires independent
 * transport possession, consumed bound OTP, source-time verification, human
 * review activation and current canonical Agent/Flow/tenant authority.
 */
export async function readVerifiedVoiceMemory(
  sql: postgres.TransactionSql,
  sessionId: string,
  agentVersionId: string,
  triggerMessageId: string,
): Promise<
  readonly {
    id: string;
    source_session_id: string;
    text: string;
    watermark: string;
    source_session_started_at: Date;
  }[]
> {
  return sql`SELECT * FROM agents.read_verified_voice_memory(${sessionId}::uuid,${agentVersionId}::uuid,${triggerMessageId}::uuid)`;
}
