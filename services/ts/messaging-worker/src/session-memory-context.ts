import type postgres from "postgres";
import {
  composeSessionMemory,
  readConversationMemoryCorrections,
  reviewedMemoryActive,
  readVerifiedVoiceMemory,
  readCustomerMemoryFacts,
  readMemorySummaries,
  resolveMemorySession,
  type MemoryTurn,
} from "@or-on/crm";

export interface TrustedSessionMemoryScope {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly agentVersionId: string;
  readonly contactId: string;
  readonly latestTriggerMessageId: string;
}
export interface SessionMemoryContext {
  readonly sessionId: string | null;
  readonly context: string;
  readonly shadow: boolean;
  readonly turnIds: readonly string[];
  readonly correctionsPresent: boolean;
}

/** Called only inside the worker's existing owned-job transaction. Identity is
 * obtained from stored conversation routing, never caller-ID or model output.
 * This adds untrusted customer context, never authorization or action receipts.
 */
export async function loadSessionMemoryContext(
  sql: postgres.TransactionSql,
  scope: TrustedSessionMemoryScope,
  options: {
    readonly idleHours?: number;
    readonly shadow?: boolean;
    readonly preserveAdmission?: boolean;
  } = {},
): Promise<SessionMemoryContext> {
  let shadow = true;
  const disabled = {
    sessionId: null,
    context: "",
    shadow,
    turnIds: [],
    correctionsPresent: false,
  } as const;
  const enabled = await sql<{ enabled: boolean }[]>`
    SELECT enabled FROM platform.tenant_remediation_flags
    WHERE tenant_id=${scope.tenantId}::uuid AND tenant_id=platform.current_tenant_id()
      AND flag_key='session_memory'
  `;
  const allowed = await sql<{ id: string }[]>`
    SELECT c.id FROM messaging.conversations c
    JOIN messaging.messages trigger ON trigger.conversation_id=c.id
      AND trigger.tenant_id=c.tenant_id
    WHERE c.id=${scope.conversationId}::uuid AND c.tenant_id=${scope.tenantId}::uuid
      AND c.tenant_id=platform.current_tenant_id()
      AND c.contact_id=${scope.contactId}::uuid AND c.ownership_mode='ai'
      AND c.removed_from_inbox_at IS NULL
      AND c.ai_agent_profile_version_id=${scope.agentVersionId}::uuid
      AND trigger.id=${scope.latestTriggerMessageId}::uuid
      AND trigger.direction='inbound' AND trigger.sender_type='contact'
  `;
  if (!allowed[0]) return disabled;
  const corrections = await readConversationMemoryCorrections(
    sql,
    scope.conversationId,
    scope.agentVersionId,
  );
  const guardedDisabled = {
    ...disabled,
    correctionsPresent: corrections.length > 0,
  };
  if (enabled[0]?.enabled !== true) return guardedDisabled;

  // A feature flag and a caller option do not establish fifty genuine human
  // reviews. Until reviewed activation, all generated memory stays shadow.
  shadow = options.shadow === true || !(await reviewedMemoryActive(sql));
  const admittedSessions =
    options.preserveAdmission === true
      ? await sql<{ id: string; started_at: Date; last_activity_at: Date }[]>`
        SELECT memory.id,memory.started_at,memory.last_activity_at FROM agents.messaging_memory_sessions memory
        JOIN messaging.conversations conversation ON conversation.id=memory.conversation_id AND conversation.tenant_id=memory.tenant_id
        WHERE memory.tenant_id=${scope.tenantId}::uuid AND memory.tenant_id=platform.current_tenant_id()
          AND memory.conversation_id=${scope.conversationId}::uuid
          AND memory.agent_version_id=${scope.agentVersionId}::uuid
          AND memory.ownership_epoch=conversation.ownership_epoch
        ORDER BY memory.last_activity_at DESC,memory.id DESC LIMIT 1`
      : [];
  const session =
    options.preserveAdmission === true
      ? admittedSessions[0]
      : await resolveMemorySession(
          sql,
          scope.conversationId,
          scope.agentVersionId,
          options.idleHours ?? 12,
        );
  if (!session) return guardedDisabled;
  const rows = await sql<{ id: string; content_text: string }[]>`
    SELECT m.id,m.content_text FROM messaging.messages m
    JOIN messaging.messages trigger ON trigger.id=${scope.latestTriggerMessageId}::uuid
      AND trigger.tenant_id=m.tenant_id AND trigger.conversation_id=m.conversation_id
    WHERE m.tenant_id=${scope.tenantId}::uuid AND m.tenant_id=platform.current_tenant_id()
      AND m.conversation_id=${scope.conversationId}::uuid
      AND m.direction='inbound' AND m.sender_type='contact'
      AND m.content_text IS NOT NULL AND length(m.content_text)>0
      AND (m.created_at,m.id)<=(trigger.created_at,trigger.id)
    ORDER BY m.created_at DESC,m.id DESC LIMIT 20
  `;
  const turns: MemoryTurn[] = rows.reverse().map((row) => ({
    id: row.id,
    text: row.content_text,
    source: "customer",
  }));
  const summaries = await readMemorySummaries(
    sql,
    session.id,
    scope.agentVersionId,
  );
  const voiceSummaries = shadow
    ? []
    : await readVerifiedVoiceMemory(
        sql,
        session.id,
        scope.agentVersionId,
        scope.latestTriggerMessageId,
      );
  const stated = (
    await readCustomerMemoryFacts(sql, session.id, scope.agentVersionId)
  ).filter((fact) => fact.confidence === "stated");
  const facts = [
    ...stated.filter(
      (fact) =>
        !corrections.some((correction) => correction.fact_key === fact.key),
    ),
    ...corrections.map((correction) => ({
      id: correction.id,
      key: correction.fact_key,
      value:
        correction.operation === "delete"
          ? "Operator deleted this memory assertion; do not reuse prior statements for this key."
          : (correction.fact_value ?? ""),
      confidence: "stated" as const,
      sourceMessageId: "",
      sourceCorrectionId: correction.id,
      provenance: "operator_correction" as const,
    })),
  ];
  // Retained history remains an audit. Until semantic source-level redaction is
  // available, any human correction suppresses reused free-text memory, which
  // can otherwise repeat the stale assertion even after its fact is deleted.
  const safeTurns = corrections.length ? [] : turns;
  const safeSummaries = corrections.length
    ? []
    : [
        ...voiceSummaries.map((row) => ({
          id: row.id,
          text: `Verified source voice customer statements (untrusted summary): ${row.text}`,
          coveredUntilMessageId: row.watermark,
          sourceSessionId: `voice:${row.source_session_id}`,
          sourceSessionStartedAt: row.source_session_started_at.toISOString(),
        })),
        ...summaries,
      ]
        .sort(
          (left, right) =>
            (left.sourceSessionStartedAt ?? "").localeCompare(
              right.sourceSessionStartedAt ?? "",
            ) ||
            (left.sourceSessionId ?? "").localeCompare(
              right.sourceSessionId ?? "",
            ),
        )
        .slice(-3);
  return {
    sessionId: session.id,
    shadow,
    turnIds: turns.map((turn) => turn.id),
    correctionsPresent: corrections.length > 0,
    context: composeSessionMemory({
      enabled: true,
      shadow,
      turns: safeTurns,
      summaries: safeSummaries,
      facts,
    }),
  };
}
