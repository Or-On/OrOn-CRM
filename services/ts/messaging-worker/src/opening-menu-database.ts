import type postgres from "postgres";
import type { ChannelCredentialEnvelope } from "./channel-credentials.js";
export interface OpeningMenuJob {
  readonly id: string;
  readonly tenant_id: string;
  readonly claim_token: string;
}
export interface OpeningMenuOffer {
  readonly kind: "offer";
  readonly tenantId: string;
  readonly conversationId: string;
  readonly channelId: string;
  readonly ownershipEpoch: number;
  readonly agentVersionId: string;
  readonly flowVersionId: string;
  readonly sourceMessageId: string;
  readonly generation: string;
  readonly operationKey: string;
  readonly language: "he" | "en";
  readonly phoneNumberId: string;
  readonly wabaId: string;
  readonly graphApiVersion: string;
  readonly recipient: string;
  readonly template: {
    readonly name: string;
    readonly language: "he" | "en";
    readonly status: "APPROVED";
    readonly servicesButtonIndex: number;
    readonly servicesButtonText: string;
    readonly supportButtonText: string;
    readonly supportButtonIndex: number;
  };
  readonly servicesPayload: string;
  readonly supportPayload: string;
}
export type StoredOpeningMenuDecision =
  | OpeningMenuOffer
  | {
      readonly kind: "disabled" | "continue" | "blocked" | "handled" | "route";
      readonly reason?: string;
      readonly generation?: string;
      readonly intent?: "services" | "support";
      readonly language?: "he" | "en";
      readonly agentVersionId?: string;
      readonly flowVersionId?: string;
      readonly allowedCapabilities?: readonly string[];
    };
export interface OpeningMenuStore {
  prepare(): Promise<StoredOpeningMenuDecision>;
  begin(): Promise<OpeningMenuOffer>;
  authorize(mode?: "read" | "send"): Promise<void>;
  credential(): Promise<ChannelCredentialEnvelope | { readonly legacy: true }>;
  settle(
    outcome: "sent" | "failed" | "unknown",
    providerMessageId: string | null,
  ): Promise<void>;
}
function decision(value: unknown): StoredOpeningMenuDecision {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    !["offer", "disabled", "continue", "blocked", "handled", "route"].includes(
      String(value.kind),
    )
  )
    throw new TypeError("Opening menu canonical decision unavailable");
  const result = value as StoredOpeningMenuDecision;
  const raw = value as Record<string, unknown>;
  if (result.kind === "offer") {
    for (const field of [
      "tenantId",
      "conversationId",
      "channelId",
      "agentVersionId",
      "flowVersionId",
      "sourceMessageId",
      "generation",
      "operationKey",
      "phoneNumberId",
      "wabaId",
      "graphApiVersion",
      "recipient",
      "servicesPayload",
      "supportPayload",
    ] as const)
      if (typeof result[field] !== "string" || result[field].length === 0)
        throw new TypeError("Opening menu canonical offer unavailable");
    if (raw.language !== "he" && raw.language !== "en")
      throw new TypeError("Opening menu language unavailable");
    const template =
      typeof raw.template === "object" && raw.template !== null
        ? (raw.template as Record<string, unknown>)
        : {};
    if (
      template.status !== "APPROVED" ||
      typeof template.servicesButtonText !== "string" ||
      !template.servicesButtonText ||
      typeof template.supportButtonText !== "string" ||
      !template.supportButtonText ||
      template.language !== raw.language ||
      typeof template.name !== "string" ||
      !/^[a-z0-9_]{1,512}$/u.test(template.name) ||
      !Number.isInteger(result.template.servicesButtonIndex) ||
      !Number.isInteger(result.template.supportButtonIndex) ||
      result.template.servicesButtonIndex ===
        result.template.supportButtonIndex ||
      result.template.servicesButtonIndex < 0 ||
      result.template.supportButtonIndex < 0 ||
      result.template.servicesButtonIndex > 9 ||
      result.template.supportButtonIndex > 9
    )
      throw new TypeError("Opening menu approved template unavailable");
  }
  if (
    result.kind === "route" &&
    (typeof raw.generation !== "string" ||
      !raw.generation ||
      (raw.intent !== "services" && raw.intent !== "support") ||
      (raw.language !== "he" && raw.language !== "en") ||
      !Array.isArray(raw.allowedCapabilities) ||
      raw.allowedCapabilities.length === 0 ||
      !raw.allowedCapabilities.every(
        (cap: unknown) =>
          typeof cap === "string" &&
          (raw.intent === "services"
            ? ["lead.read", "lead.write", "lead.finalize", "lead.follow_up"]
            : ["ticket.open", "service.intake"]
          ).includes(cap),
      ))
  )
    throw new TypeError("Opening menu canonical route unavailable");
  return result;
}
/** Only server job identity enters SQL; no model arguments or human GUC. */
export function createOpeningMenuStore(
  sql: postgres.Sql,
  workerId: string,
  job: OpeningMenuJob,
): OpeningMenuStore {
  const transaction = <T>(
    operation: (tx: postgres.TransactionSql) => Promise<T>,
  ) =>
    sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant',${job.tenant_id},true),set_config('app.current_user','',true)`;
      return operation(tx);
    }) as Promise<T>;
  return {
    prepare: () =>
      transaction(async (tx) => {
        const rows = await tx<
          { decision: unknown }[]
        >`SELECT platform.prepare_opening_menu(${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS decision`;
        return decision(rows[0]?.decision);
      }),
    begin: () =>
      transaction(async (tx) => {
        const rows = await tx<
          { decision: unknown }[]
        >`SELECT platform.begin_opening_menu_attempt(${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS decision`;
        const result = decision(rows[0]?.decision);
        if (result.kind !== "offer")
          throw new TypeError("Opening menu offer unavailable");
        return result;
      }),
    authorize: (mode = "send") =>
      transaction(async (tx) => {
        if (mode === "read") {
          const rows = await tx<
            { credential: unknown }[]
          >`SELECT platform.opening_menu_channel_credential(${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS credential`;
          if (rows[0]?.credential === null || rows[0]?.credential === undefined)
            throw new Error("Opening menu authority changed");
          return;
        }
        const rows = await tx<
          { allowed: boolean }[]
        >`SELECT platform.opening_menu_attempt_authorized(${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS allowed`;
        if (rows[0]?.allowed !== true)
          throw new Error("Opening menu authority changed");
      }),
    credential: () =>
      transaction(async (tx) => {
        const rows = await tx<
          { credential: unknown }[]
        >`SELECT platform.opening_menu_channel_credential(${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS credential`;
        const value = rows[0]?.credential;
        if (typeof value !== "object" || value === null)
          throw new TypeError("Opening menu credential unavailable");
        if ("legacy" in value && value.legacy === true) return { legacy: true };
        const envelope = value as ChannelCredentialEnvelope;
        if (
          typeof envelope.tenantId !== "string" ||
          typeof envelope.channelId !== "string" ||
          typeof envelope.credentialId !== "string" ||
          typeof envelope.kind !== "string" ||
          envelope.tenantId !== job.tenant_id
        )
          throw new TypeError("Opening menu credential binding unavailable");
        return envelope;
      }),
    settle: (outcome, providerMessageId) =>
      transaction(async (tx) => {
        await tx`SELECT platform.settle_opening_menu_attempt(${job.id}::uuid,${workerId},${job.claim_token}::uuid,${outcome},${providerMessageId})`;
      }),
  };
}
/** Restrictive gate only: existing provider/tool/human authorization must still run. */
export async function openingMenuBusinessJobAllowed(
  sql: postgres.Sql,
  workerId: string,
  job: OpeningMenuJob,
): Promise<boolean> {
  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant',${job.tenant_id},true),set_config('app.current_user','',true)`;
    const rows = await tx<
      { allowed: boolean }[]
    >`SELECT platform.opening_menu_business_job_allowed(${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS allowed`;
    return rows[0]?.allowed === true;
  });
}
