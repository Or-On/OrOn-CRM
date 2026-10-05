/** Machine identities are execution authority, never human consent or login identities. */
export const conversationPrincipalRole = "conversation_model_reader_v1";

export type PrincipalAdmission =
  | { readonly mode: "legacy" }
  | { readonly mode: "principal"; readonly principalId: string }
  | { readonly mode: "denied"; readonly reason: string }
  | { readonly mode: "stale" };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasons = new Set([
  "principal_missing",
  "principal_inactive",
  "principal_membership_invalid",
  "principal_role_invalid",
  "principal_tool_bridge_unavailable",
]);

/** Accept only the narrow, fresh server-owned projection; no role from LLM/user text. */
export function parsePrincipalAdmission(value: unknown): PrincipalAdmission {
  if (value === null) return { mode: "stale" };
  if (typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid principal admission projection");
  const row = value as Record<string, unknown>;
  if (row.mode === "legacy") return { mode: "legacy" };
  if (
    row.mode === "principal" &&
    row.role === conversationPrincipalRole &&
    typeof row.principalId === "string" &&
    uuid.test(row.principalId) &&
    Array.isArray(row.toolPermissions) &&
    row.toolPermissions.length === 0
  )
    return { mode: "principal", principalId: row.principalId };
  if (
    row.mode === "denied" &&
    typeof row.reason === "string" &&
    reasons.has(row.reason)
  )
    return { mode: "denied", reason: row.reason };
  throw new TypeError("invalid principal admission projection");
}

export class AiPrincipalDeniedError extends TypeError {
  constructor(reason = "ai_execution_principal_unavailable") {
    super(reason);
    this.name = "AiPrincipalDeniedError";
  }
}

/** A job may lose authority, but cannot switch execution identity mid-turn. */
export function retainPrincipalAdmission(
  expected: PrincipalAdmission | undefined,
  current: PrincipalAdmission,
): Exclude<PrincipalAdmission, { mode: "denied" | "stale" }> {
  if (current.mode === "denied" || current.mode === "stale")
    throw new AiPrincipalDeniedError();
  if (
    expected !== undefined &&
    (expected.mode !== current.mode ||
      (expected.mode === "principal" &&
        current.mode === "principal" &&
        expected.principalId !== current.principalId))
  )
    throw new AiPrincipalDeniedError("ai_execution_principal_changed");
  return current;
}

/** Call after the resolver transaction committed its durable invalid alert. */
export async function withPrincipalAdmission<T>(
  readFresh: () => Promise<unknown>,
  operation: (
    admission: Exclude<PrincipalAdmission, { mode: "denied" | "stale" }>,
  ) => Promise<T>,
): Promise<T> {
  const admission = parsePrincipalAdmission(await readFresh());
  if (admission.mode === "denied" || admission.mode === "stale")
    throw new AiPrincipalDeniedError();
  return operation(admission);
}
