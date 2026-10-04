import type postgres from "postgres";

export interface MemoryTurn {
  readonly id: string;
  readonly text: string;
  readonly source: "customer" | "verified_action";
}
export interface CustomerMemoryFact {
  readonly id: string;
  readonly key: string;
  readonly value: string;
  readonly confidence: "stated" | "verified";
  readonly sourceMessageId: string;
  readonly sourceCorrectionId?: string;
  readonly provenance?: "customer_statement" | "operator_correction";
}
export interface MemorySummary {
  readonly id: string;
  readonly text: string;
  readonly coveredUntilMessageId: string;
  readonly sourceSessionId?: string;
  readonly sourceSessionStartedAt?: string;
}

/** Multilingual context is bounded by Unicode code points. This is not a
 * measured provider token count. Authority and secrets never belong here.
 */
export function composeSessionMemory(input: {
  readonly enabled: boolean;
  readonly shadow: boolean;
  readonly turns: readonly MemoryTurn[];
  readonly summaries: readonly MemorySummary[];
  readonly facts: readonly CustomerMemoryFact[];
  readonly tokenBudget?: number;
}): string {
  if (!input.enabled || input.shadow) return "";
  const budget = input.tokenBudget ?? 4000;
  if (!Number.isInteger(budget) || budget < 1 || budget > 4000)
    throw new TypeError("memory budget must be 1-4000");
  const operatorEntries = input.facts
    .filter((fact) => fact.provenance === "operator_correction")
    .map(
      (fact) =>
        `[operator correction ${fact.sourceCorrectionId ?? fact.id}] ${fact.key}: ${fact.value}`,
    );
  const operatorSize = operatorEntries.reduce(
    (sum, entry) => sum + Array.from(entry).length + 1,
    0,
  );
  // Fail closed rather than omit a human correction in favor of stale memory.
  if (operatorSize > budget) return "";
  const sections = [
    ...input.facts
      .filter((fact) => fact.provenance !== "operator_correction")
      .slice(-30)
      .map(
        (fact) =>
          `[${fact.confidence}; message ${fact.sourceMessageId}] ${fact.key}: ${fact.value}`,
      ),
    ...input.summaries
      .slice(-3)
      .map(
        (summary) =>
          `[summary${summary.sourceSessionId ? ` session ${summary.sourceSessionId}` : ""} through ${summary.coveredUntilMessageId}] ${summary.text}`,
      ),
    ...input.turns
      .slice(-20)
      .map((turn) => `[${turn.source}; message ${turn.id}] ${turn.text}`),
  ];
  // Preserve complete provenance markers; drop old complete entries first.
  const retained: string[] = [];
  let remaining = budget - operatorSize;
  for (const entry of sections.reverse()) {
    const size = Array.from(entry).length + (retained.length ? 1 : 0);
    if (size > remaining) continue;
    retained.unshift(entry);
    remaining -= size;
  }
  return [...retained, ...operatorEntries].join("\n");
}

export function summaryInputs(
  turns: readonly MemoryTurn[],
): readonly MemoryTurn[] {
  return turns
    .filter((turn) => new Set(["customer", "verified_action"]).has(turn.source))
    .slice(-20);
}

export interface SessionSummarizer {
  summarize(input: {
    readonly customerTurns: readonly MemoryTurn[];
  }): Promise<string>;
}

/** A server-owned job calls this after resolving its session, never on a live
 * media thread. It supplies customer messages only; generated notes are not
 * accepted as evidence. The provider output is untrusted shadow text.
 */
export async function generateShadowSummary(
  provider: SessionSummarizer,
  turns: readonly MemoryTurn[],
): Promise<{
  readonly text: string;
  readonly sourceMessageIds: readonly string[];
  readonly coveredUntilMessageId: string;
} | null> {
  const sources = summaryInputs(turns).filter(
    (turn) => turn.source === "customer",
  );
  const covered = sources.at(-1);
  if (covered === undefined) return null;
  const text = await provider.summarize({ customerTurns: sources });
  if (
    typeof text !== "string" ||
    !text.trim() ||
    Array.from(text).length > 4000
  )
    throw new TypeError("invalid shadow summary output");
  return {
    text,
    sourceMessageIds: sources.map((turn) => turn.id),
    coveredUntilMessageId: covered.id,
  };
}

export interface MemorySession {
  readonly id: string;
  readonly started_at: string;
  readonly last_activity_at: string;
}

/** Caller supplies server-resolved conversation/Agent identifiers inside the
 * existing tenant transaction. This API never accepts caller-ID authentication.
 */
export async function resolveMemorySession(
  sql: postgres.TransactionSql,
  conversationId: string,
  agentVersionId: string,
  idleHours = 12,
): Promise<MemorySession> {
  if (!Number.isInteger(idleHours) || idleHours < 1 || idleHours > 168)
    throw new TypeError("session idle hours must be 1-168");
  const rows = await sql<MemorySession[]>`
    SELECT * FROM agents.resolve_messaging_memory_session(
      ${conversationId}::uuid,${agentVersionId}::uuid,${idleHours})
  `;
  if (!rows[0]) throw new Error("memory session unavailable");
  return rows[0];
}

export async function readMemorySummaries(
  sql: postgres.TransactionSql,
  sessionId: string,
  agentVersionId: string,
): Promise<readonly MemorySummary[]> {
  const rows = await sql<
    {
      id: string;
      text: string;
      covered_until_message_id: string;
      session_id: string;
      source_session_started_at: Date;
    }[]
  >`
    SELECT latest.id,latest.text,latest.covered_until_message_id,session.id session_id,session.started_at source_session_started_at
    FROM agents.messaging_memory_sessions current_session
    JOIN messaging.conversations current_conversation
      ON current_conversation.id=current_session.conversation_id AND current_conversation.tenant_id=current_session.tenant_id
        AND current_session.ownership_epoch=current_conversation.ownership_epoch
    JOIN agents.agent_profile_versions current_agent
      ON current_agent.id=current_session.agent_version_id
        AND current_agent.tenant_id=current_session.tenant_id
    JOIN agents.agent_profiles profile ON profile.id=current_agent.agent_profile_id
      AND profile.tenant_id=current_agent.tenant_id AND profile.archived_at IS NULL
    JOIN agents.messaging_memory_sessions session
      ON session.tenant_id=current_session.tenant_id
        AND session.conversation_id=current_session.conversation_id
        AND (session.started_at,session.id)<(current_session.started_at,current_session.id)
    JOIN agents.agent_profile_versions prior_agent
      ON prior_agent.id=session.agent_version_id AND prior_agent.tenant_id=session.tenant_id
        AND prior_agent.agent_profile_id=current_agent.agent_profile_id
        AND prior_agent.published_at IS NOT NULL AND prior_agent.validation_status='valid'
    CROSS JOIN LATERAL (
      SELECT summary.id,summary.text,summary.covered_until_message_id
      FROM agents.messaging_memory_summaries summary
      WHERE summary.session_id=session.id AND summary.tenant_id=session.tenant_id
      ORDER BY summary.created_at DESC,summary.id DESC LIMIT 1
    ) latest
    WHERE current_session.id=${sessionId}::uuid
      AND current_session.agent_version_id=${agentVersionId}::uuid
      AND current_session.tenant_id=platform.current_tenant_id()
      AND current_agent.published_at IS NOT NULL AND current_agent.validation_status='valid'
    ORDER BY session.started_at DESC,session.id DESC LIMIT 3
  `;
  return rows.reverse().map((row) => ({
    id: row.id,
    text: row.text,
    coveredUntilMessageId: row.covered_until_message_id,
    sourceSessionId: row.session_id,
    sourceSessionStartedAt: row.source_session_started_at.toISOString(),
  }));
}

export async function readCustomerMemoryFacts(
  sql: postgres.TransactionSql,
  sessionId: string,
  agentVersionId: string,
): Promise<readonly CustomerMemoryFact[]> {
  const rows = await sql<
    {
      id: string;
      fact_key: string;
      fact_value: string;
      confidence: "stated" | "verified";
      source_message_id: string;
    }[]
  >`
    SELECT DISTINCT ON(f.fact_key) f.id,f.fact_key,f.fact_value,f.confidence,f.source_message_id
    FROM agents.customer_memory_facts f
    JOIN agents.messaging_memory_sessions s ON s.id=f.session_id AND s.tenant_id=f.tenant_id
    JOIN agents.messaging_memory_sessions current_session
      ON current_session.id=${sessionId}::uuid AND current_session.tenant_id=s.tenant_id
        AND current_session.conversation_id=s.conversation_id
    JOIN messaging.conversations current_conversation
      ON current_conversation.id=current_session.conversation_id AND current_conversation.tenant_id=current_session.tenant_id
        AND current_session.ownership_epoch=current_conversation.ownership_epoch
    JOIN agents.agent_profile_versions current_agent
      ON current_agent.id=current_session.agent_version_id AND current_agent.tenant_id=s.tenant_id
    JOIN agents.agent_profile_versions prior_agent
      ON prior_agent.id=s.agent_version_id AND prior_agent.tenant_id=s.tenant_id
        AND prior_agent.agent_profile_id=current_agent.agent_profile_id
    JOIN agents.agent_profiles profile
      ON profile.id=current_agent.agent_profile_id AND profile.tenant_id=s.tenant_id
    WHERE (s.started_at,s.id)<=(current_session.started_at,current_session.id)
      AND current_session.agent_version_id=${agentVersionId}::uuid
      AND current_agent.published_at IS NOT NULL AND current_agent.validation_status='valid'
      AND prior_agent.published_at IS NOT NULL AND prior_agent.validation_status='valid'
      AND profile.archived_at IS NULL
      AND s.tenant_id=platform.current_tenant_id()
    ORDER BY f.fact_key,f.created_at DESC,f.id DESC LIMIT 30
  `;
  return rows.reverse().map((row) => ({
    id: row.id,
    key: row.fact_key,
    value: row.fact_value,
    confidence: row.confidence,
    sourceMessageId: row.source_message_id,
  }));
}

export async function writeMemorySummary(
  sql: postgres.TransactionSql,
  input: {
    readonly sessionId: string;
    readonly coveredUntilMessageId: string;
    readonly sourceMessageIds: readonly string[];
    readonly text: string;
  },
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    SELECT agents.write_messaging_memory_summary(${input.sessionId}::uuid,
      ${input.coveredUntilMessageId}::uuid,${[...input.sourceMessageIds]}::uuid[],${input.text}) id
  `;
  if (!rows[0]) throw new Error("memory summary unavailable");
  return rows[0].id;
}

export async function writeStatedCustomerFact(
  sql: postgres.TransactionSql,
  input: {
    readonly sessionId: string;
    readonly sourceMessageId: string;
    readonly key:
      | "name"
      | "city"
      | "business_need"
      | "contact_preference"
      | "appointment_preference";
    readonly value: string;
  },
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    SELECT agents.write_customer_memory_fact(${input.sessionId}::uuid,
      ${input.sourceMessageId}::uuid,${input.key},${input.value}) id
  `;
  if (!rows[0]) throw new Error("memory fact unavailable");
  return rows[0].id;
}
