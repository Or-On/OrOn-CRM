import type postgres from "postgres";
import {
  assertAgentKnowledgePublishable,
  parseKnowledgeSourceIds,
} from "@or-on/crm";
import { parseTrustedModelSettings } from "./trusted-model-routing.js";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("session model route unavailable");
  return value as Record<string, unknown>;
}

/** Metadata eligibility only. No secret reads, quota reservations or providers.
 * Actual credential authentication remains mandatory before a physical call.
 */
export function assertSessionModelProjection(
  value: unknown,
  scope: { readonly tenantId: string; readonly agentVersionId: string },
): void {
  const route = record(value);
  const binding = record(route.binding);
  if (
    binding.tenantId !== scope.tenantId ||
    binding.agentVersionId !== scope.agentVersionId ||
    binding.published !== true ||
    binding.validationStatus !== "valid" ||
    binding.authorized !== true
  )
    throw new TypeError("session model binding denied");
  if (binding.modelConfigurationId === null) return;
  const configuration = record(route.configuration);
  const credential = record(route.modelCredential);
  if (
    configuration.id !== binding.modelConfigurationId ||
    configuration.tenantId !== scope.tenantId ||
    configuration.enabled !== true ||
    !["openai", "gemini"].includes(String(configuration.provider)) ||
    typeof configuration.model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(configuration.model) ||
    parseTrustedModelSettings(configuration.settings) === null ||
    (configuration.dailyRequestLimit !== null &&
      (typeof configuration.dailyRequestLimit !== "number" ||
        !Number.isSafeInteger(configuration.dailyRequestLimit) ||
        configuration.dailyRequestLimit < 1)) ||
    typeof configuration.credentialId !== "string" ||
    credential.id !== configuration.credentialId ||
    credential.tenantId !== scope.tenantId ||
    credential.kind !== "llm_api_key_v2" ||
    credential.envelopePresent !== true ||
    typeof credential.keyVersion !== "number" ||
    !Number.isSafeInteger(credential.keyVersion) ||
    credential.keyVersion < 1
  )
    throw new TypeError("session explicit model configuration unavailable");
}

/** Root calls before the Agent JOIN, inside the existing owned-job transaction.
 * All failures must propagate to roll back version/session/admission together.
 */
export async function admitSessionAgent(
  sql: postgres.TransactionSql,
  claim: {
    readonly jobId: string;
    readonly workerId: string;
    readonly claimToken: string;
  },
): Promise<string | null> {
  const flags = await sql<{ enabled: boolean }[]>`
    SELECT enabled FROM platform.tenant_remediation_flags
    WHERE tenant_id=platform.current_tenant_id() AND flag_key='session_memory'
  `;
  if (flags[0]?.enabled !== true) return null;
  const selected = await sql<{ id: string }[]>`
    SELECT platform.admit_messaging_session_agent(
      ${claim.jobId}::uuid,${claim.workerId},${claim.claimToken}::uuid,12) id
  `;
  const id = selected[0]?.id;
  if (typeof id !== "string")
    throw new TypeError("session Agent admission unavailable");
  const rows = await sql<
    { tenant_id: string; route: unknown; knowledge_configuration: unknown }[]
  >`
    SELECT c.tenant_id,platform.current_published_model_route(
      a.id,c.ai_enabled_by_user_id,c.channel_id) route,a.knowledge_configuration
    FROM ops.jobs j
    JOIN messaging.conversations c ON c.id=j.reference_id AND c.tenant_id=j.tenant_id
    JOIN agents.agent_profile_versions a ON a.id=c.ai_agent_profile_version_id
      AND a.tenant_id=c.tenant_id AND a.id=${id}::uuid
    WHERE j.id=${claim.jobId}::uuid AND j.tenant_id=platform.current_tenant_id()
      AND j.status='running' AND j.locked_by=${claim.workerId}
      AND j.claim_token=${claim.claimToken}::uuid AND j.lease_expires_at>clock_timestamp()
  `;
  const row = rows[0];
  if (row === undefined) throw new TypeError("session Agent binding changed");
  assertSessionModelProjection(row.route, {
    tenantId: row.tenant_id,
    agentVersionId: id,
  });
  const knowledge = record(row.knowledge_configuration);
  await assertAgentKnowledgePublishable(
    sql,
    parseKnowledgeSourceIds(knowledge.sourceIds ?? []),
  );
  return id;
}
