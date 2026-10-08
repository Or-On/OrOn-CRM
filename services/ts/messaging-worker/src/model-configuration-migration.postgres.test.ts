import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { expect, it } from "vitest";
import {
  sealModelCredential,
  createModelCredentialResolver,
} from "./model-credentials.js";
import {
  inspectModelMigration,
  prepareModelMigration,
} from "./model-configuration-migration.js";

const url = process.env.CRM_TEST_DATABASE_URL;
class Rollback extends Error {}
it.skipIf(!url)(
  "clones a reviewed model and its bound credential under tenant admin RLS",
  async () => {
    if (!url || !/^(localhost|127\.0\.0\.1)$/u.test(new URL(url).hostname))
      throw new Error("Local DB required");
    const db = postgres(url, { max: 1 });
    try {
      await db
        .begin(async (sql) => {
          const tenant = randomUUID(),
            actor = randomUUID(),
            source = randomUUID(),
            oldCredential = randomUUID();
          const key = randomBytes(32),
            keys = new Map([["env:model:v2", key]]);
          await sql`INSERT INTO public.tenants(id,name,slug) VALUES(${tenant}::uuid,'Synthetic model migration',${tenant})`;
          await sql`INSERT INTO public.users(id,email,display_name,status) VALUES(${actor}::uuid,${actor + "@example.invalid"},'Synthetic owner','active')`;
          await sql`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${actor}::uuid,'owner')`;
          const sealed = sealModelCredential(
            {
              tenantId: tenant,
              modelConfigurationId: source,
              credentialId: oldCredential,
              provider: "gemini",
            },
            "synthetic-token",
            key,
          );
          await sql`INSERT INTO platform.credential_records(id,tenant_id,kind,algorithm,key_version,ciphertext,nonce)
        VALUES(${oldCredential}::uuid,${tenant}::uuid,${sealed.kind},${sealed.algorithm},${sealed.keyVersion},decode(${sealed.ciphertext},'hex'),decode(${sealed.nonce},'hex'))`;
          await sql`INSERT INTO agents.model_configurations(id,tenant_id,name,provider,model,credential_id,settings,daily_request_limit,is_enabled)
        VALUES(${source}::uuid,${tenant}::uuid,'Synthetic custom route','gemini','gemini-2.5-flash-lite',${oldCredential}::uuid,'{"maxTokens":1024}',17,true)`;
          await sql`SET LOCAL ROLE platform_web`;
          await sql`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${actor},true),set_config('app.current_role','owner',true)`;
          const plan = {
            tenantId: tenant,
            sourceConfigurationId: source,
            targetConfigurationId: randomUUID(),
            targetCredentialId: randomUUID(),
            expectedSourceDigest: "",
          };
          plan.expectedSourceDigest = (
            await inspectModelMigration(sql, plan)
          ).digest;
          const result = await prepareModelMigration(sql, actor, plan, keys);
          expect(await prepareModelMigration(sql, actor, plan, keys)).toEqual(
            result,
          );
          await expect(
            prepareModelMigration(
              sql,
              actor,
              { ...plan, targetCredentialId: randomUUID() },
              keys,
            ),
          ).rejects.toThrow("content changed");
          const [record] =
            await sql`SELECT model,daily_request_limit,settings FROM agents.model_configurations WHERE id=${plan.targetConfigurationId}::uuid`;
          expect(record).toMatchObject({
            model: "gemini-3.5-flash-lite",
            daily_request_limit: 17,
            settings: {
              maxTokens: 1024,
              fallbackModel: "gemini-3.1-flash-lite",
            },
          });
          const [envelope] =
            await sql`SELECT kind,algorithm,key_version,encode(ciphertext,'hex') AS ciphertext,encode(nonce,'hex') AS nonce FROM platform.credential_records WHERE id=${plan.targetCredentialId}::uuid`;
          if (!envelope) throw new Error("missing credential");
          expect(
            createModelCredentialResolver(keys)({
              tenantId: tenant,
              modelConfigurationId: plan.targetConfigurationId,
              credentialId: plan.targetCredentialId,
              provider: "gemini",
              kind: String(envelope.kind),
              algorithm: String(envelope.algorithm),
              keyVersion: String(envelope.key_version),
              ciphertext: String(envelope.ciphertext),
              nonce: String(envelope.nonce),
            }).apiKey,
          ).toBe("synthetic-token");
          expect(
            (
              await sql`SELECT model FROM agents.model_configurations WHERE id=${source}::uuid`
            )[0]?.model,
          ).toBe("gemini-2.5-flash-lite");
          await expect(
            inspectModelMigration(sql, { ...plan, tenantId: randomUUID() }),
          ).rejects.toThrow("tenant-owned");
          expect(
            await sql`SELECT id FROM agents.agent_profile_versions`,
          ).toHaveLength(0);
          throw new Rollback();
        })
        .catch((error: unknown) => {
          if (!(error instanceof Rollback)) throw error;
        });
    } finally {
      await db.end();
    }
  },
);
