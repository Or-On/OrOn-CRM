/** Reviewed admin operation, never part of automatic request routing. */
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { assertKnowledgeManager } from "@or-on/crm";
import { agentRuntimePolicy } from "@or-on/config";
import {
  createModelCredentialResolver,
  sealModelCredential,
} from "./model-credentials.js";

export interface ModelMigrationPlan {
  tenantId: string;
  sourceConfigurationId: string;
  targetConfigurationId: string;
  targetCredentialId: string;
  expectedSourceDigest: string;
}

export async function inspectModelMigration(
  sql: postgres.TransactionSql,
  plan: ModelMigrationPlan,
) {
  await assertKnowledgeManager(sql);
  const [source] = await sql<
    {
      id: string;
      tenant_id: string;
      name: string;
      provider: string;
      model: string;
      credential_id: string;
      settings: Record<string, string | number>;
      daily_request_limit: number | null;
      is_enabled: boolean;
    }[]
  >`SELECT id,tenant_id,name,provider,model,credential_id,settings,daily_request_limit,is_enabled
    FROM agents.model_configurations WHERE id=${plan.sourceConfigurationId}::uuid
      AND tenant_id=platform.current_tenant_id() AND tenant_id=${plan.tenantId}::uuid`;
  if (!source || !source.is_enabled || source.provider !== "gemini")
    throw new TypeError(
      "An enabled tenant-owned Gemini source route is required",
    );
  const digest = createHash("sha256")
    .update(JSON.stringify(source))
    .digest("hex");
  return {
    source,
    digest,
    targetModel: agentRuntimePolicy.requestedPrimary,
    fallbackModel: agentRuntimePolicy.requestedFallback,
  };
}

/** Clone configuration AND rebind encryption AAD. Never edit a published reference. */
export async function prepareModelMigration(
  sql: postgres.TransactionSql,
  actor: string,
  plan: ModelMigrationPlan,
  keys: ReadonlyMap<string, Buffer>,
) {
  await assertKnowledgeManager(sql);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(platform.current_tenant_id()::text||':model-migration',0))`;
  const planDigest = createHash("sha256")
    .update(JSON.stringify(plan))
    .digest("hex");
  const [previous] = await sql<
    { metadata: { planDigest: string } }[]
  >`SELECT metadata FROM audit.records
    WHERE action='model.configuration.cloned' AND target_id=${plan.targetConfigurationId}::uuid`;
  if (previous) {
    if (previous.metadata.planDigest !== planDigest)
      throw new TypeError("Model migration content changed");
    return { configurationId: plan.targetConfigurationId, activated: false };
  }
  await sql`SELECT id FROM agents.model_configurations WHERE tenant_id=platform.current_tenant_id()
    AND id=${plan.sourceConfigurationId}::uuid FOR SHARE`;
  const { source, digest } = await inspectModelMigration(sql, plan);
  if (digest !== plan.expectedSourceDigest)
    throw new TypeError("Source model route changed; review again");
  if (
    plan.sourceConfigurationId === plan.targetConfigurationId ||
    source.credential_id === plan.targetCredentialId
  )
    throw new TypeError(
      "New immutable configuration and credential identities are required",
    );
  const [credential] = await sql<
    {
      kind: string;
      algorithm: string;
      key_version: string;
      ciphertext: string;
      nonce: string;
    }[]
  >`
    SELECT kind,algorithm,key_version,encode(ciphertext,'hex') AS ciphertext,encode(nonce,'hex') AS nonce
    FROM platform.credential_records WHERE tenant_id=platform.current_tenant_id() AND id=${source.credential_id}::uuid FOR SHARE`;
  const key = keys.get("env:model:v2");
  if (!credential || !key) throw new TypeError("Model credential unavailable");
  const decoded = createModelCredentialResolver(
    keys,
    0,
  )({
    ...credential,
    keyVersion: credential.key_version,
    tenantId: plan.tenantId,
    modelConfigurationId: source.id,
    credentialId: source.credential_id,
    provider: "gemini",
  });
  const sealed = sealModelCredential(
    {
      tenantId: plan.tenantId,
      modelConfigurationId: plan.targetConfigurationId,
      credentialId: plan.targetCredentialId,
      provider: "gemini",
    },
    decoded.apiKey,
    key,
  );
  await sql`INSERT INTO platform.credential_records(id,tenant_id,kind,algorithm,key_version,ciphertext,nonce)
    VALUES(${plan.targetCredentialId}::uuid,platform.current_tenant_id(),${sealed.kind},${sealed.algorithm},${sealed.keyVersion},
      decode(${sealed.ciphertext},'hex'),decode(${sealed.nonce},'hex'))`;
  await sql`INSERT INTO agents.model_configurations(id,tenant_id,name,provider,model,credential_id,settings,daily_request_limit,is_enabled)
    VALUES(${plan.targetConfigurationId}::uuid,platform.current_tenant_id(),${source.name + " · reviewed model update"},'gemini',
      ${agentRuntimePolicy.requestedPrimary},${plan.targetCredentialId}::uuid,
      ${sql.json({ ...source.settings, fallbackModel: agentRuntimePolicy.requestedFallback })},${source.daily_request_limit},true)`;
  await sql`INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,metadata)
    VALUES(platform.current_tenant_id(),${actor}::uuid,'model.configuration.cloned','model_configuration',
      ${plan.targetConfigurationId}::uuid,${sql.json({
        planDigest,
        sourceConfigurationId: source.id,
        targetConfigurationId: plan.targetConfigurationId,
        activated: false,
      })})`;
  return { configurationId: plan.targetConfigurationId, activated: false };
}
