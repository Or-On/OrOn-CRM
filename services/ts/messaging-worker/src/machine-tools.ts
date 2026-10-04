import { AiPrincipalDeniedError } from "./ai-principal.js";
import type postgres from "postgres";

export interface MachineToolAuthority {
  readonly principalId: string;
  readonly agentVersionId: string;
  readonly conversationId: string;
  readonly contactId: string;
  readonly sourceMessageId: string;
  readonly ownershipEpoch: string;
}

/** The SQL port owns identities and grants; model arguments never enter it. */
export async function authorizeMachineTool(
  transaction: postgres.TransactionSql,
  job: { readonly id: string; readonly claim_token: string },
  workerId: string,
  capability: string,
  expected: {
    readonly agentVersionId: string;
    readonly conversationId: string;
    readonly contactId: string;
    readonly triggerMessageId: string;
    readonly ownershipEpoch: string;
  },
): Promise<MachineToolAuthority | null> {
  let rows: { authority: unknown }[];
  try {
    rows = await transaction<{ authority: unknown }[]>`
    SELECT platform.authorize_machine_tool(${job.id}::uuid,${workerId},
      ${job.claim_token}::uuid,${capability}) AS authority`;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "42501"
    )
      throw new AiPrincipalDeniedError();
    throw error;
  }
  const value = rows[0]?.authority;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("machine tool authority unavailable");
  const row = value as Record<string, unknown>;
  if (row.mode === "legacy") return null;
  if (
    row.mode !== "principal" ||
    typeof row.principalId !== "string" ||
    row.agentVersionId !== expected.agentVersionId ||
    row.conversationId !== expected.conversationId ||
    row.contactId !== expected.contactId ||
    row.sourceMessageId !== expected.triggerMessageId ||
    String(row.ownershipEpoch) !== expected.ownershipEpoch
  )
    throw new TypeError("machine tool authority binding changed");
  await transaction`SELECT set_config('app.current_user','',true)`;
  return {
    principalId: row.principalId,
    agentVersionId: expected.agentVersionId,
    conversationId: expected.conversationId,
    contactId: expected.contactId,
    sourceMessageId: expected.triggerMessageId,
    ownershipEpoch: expected.ownershipEpoch,
  };
}
