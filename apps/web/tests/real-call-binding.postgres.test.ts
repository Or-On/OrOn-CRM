import { randomUUID } from "node:crypto";
import postgres, { type TransactionSql } from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sql: undefined as TransactionSql | undefined,
  failure: undefined as Error | undefined,
}));
vi.mock("@or-on/crm", () => ({
  getContact: () =>
    Promise.resolve({
      lifecycleStatus: "active",
      voiceConsent: "granted",
      identities: [
        {
          channel: "phone",
          normalizedValue: "+14155550109",
          validationStatus: "valid",
        },
      ],
    }),
}));
vi.mock("../src/features/auth", () => ({
  assertAuthenticatedMutation: () =>
    Promise.resolve({ userId: "fictional-operator" }),
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  jsonObject: (request: Request) => request.json(),
  issueDispatcherGrant: () => Promise.resolve("fictional-dispatcher-grant"),
  withCurrentTenant: async (
    _permission: string,
    work: (sql: TransactionSql) => Promise<unknown>,
  ) => {
    if (!state.sql) throw new Error("Fixture unavailable");
    try {
      return await work(state.sql);
    } catch (error) {
      if (!(error instanceof TypeError))
        state.failure =
          error instanceof Error
            ? error
            : new Error("Unexpected fixture failure");
      throw error;
    }
  },
}));
import { POST } from "../src/app/api/voice/real-calls/route";

const databaseUrl = process.env.TEST_DATABASE_URL;
class RollbackFixture extends Error {}
function assertNoScopeFailure() {
  if (state.failure !== undefined) throw state.failure;
}
interface Binding {
  readonly definitionId: string;
  readonly canonicalId: string;
  readonly retainedVersion: number;
}

async function isolated(
  work: (
    sql: TransactionSql,
    fixture: {
      tenantId: string;
      agentId: string;
      retainedId: string;
      binding: (retainedVersion: number, prior?: Binding) => Promise<Binding>;
      process: (
        binding: Binding,
        trigger: string,
        priority?: number,
      ) => Promise<void>;
      approved: () => Promise<void>;
      invoke: (scopeTenantId?: string) => Promise<Response>;
    },
  ) => Promise<void>,
) {
  const target = new URL(databaseUrl ?? "");
  if (
    target.hostname !== "127.0.0.1" ||
    !/^\/oron_ui_preview_[a-f0-9]{32}$/u.test(target.pathname)
  )
    throw new Error("Owned isolated PostgreSQL fixture required");
  const db = postgres(databaseUrl ?? "", { max: 1 });
  try {
    await db.begin(async (sql) => {
      const tenantId = randomUUID(),
        userId = randomUUID(),
        profileId = randomUUID(),
        agentId = randomUUID(),
        retainedId = randomUUID();
      await sql`INSERT INTO tenants(id,name,slug,status) VALUES(${tenantId}::uuid,'Fictional voice routing',${tenantId},'active')`;
      await sql`INSERT INTO users(id,email,status) VALUES(${userId}::uuid,${`${userId}@example.invalid`},'active')`;
      await sql`INSERT INTO memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'owner')`;
      await sql`INSERT INTO agents.agent_profiles(id,tenant_id,name) VALUES(${profileId}::uuid,${tenantId}::uuid,'Fictional agent')`;
      await sql`INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,system_prompt,channel_capabilities,validation_status,published_at)
        VALUES(${agentId}::uuid,${tenantId}::uuid,${profileId}::uuid,4,'Fictional prompt',ARRAY['voice','whatsapp'],'valid',now())`;
      const fixture = {
        tenantId,
        agentId,
        retainedId,
        binding: async (
          retainedVersion: number,
          prior?: Binding,
        ): Promise<Binding> => {
          const definitionId = prior?.definitionId ?? randomUUID(),
            canonicalId = randomUUID();
          if (!prior)
            await sql`INSERT INTO automation.flow_definitions(id,tenant_id,name,channel_capabilities)
            VALUES(${definitionId}::uuid,${tenantId}::uuid,${`Fictional flow ${definitionId}`},ARRAY['voice','whatsapp'])`;
          await sql`INSERT INTO public.flows(flow_id,version,tenant_id,source,spec,components_version)
            VALUES(${retainedId}::uuid,${retainedVersion},${tenantId}::uuid,'{}','{}','fictional') ON CONFLICT DO NOTHING`;
          await sql`INSERT INTO automation.flow_versions(id,tenant_id,flow_definition_id,version,schema_version,definition,validation_status,published_at,agent_profile_version_id)
            VALUES(${canonicalId}::uuid,${tenantId}::uuid,${definitionId}::uuid,${prior ? 2 : 1},'1.0',${sql.json({ nodes: [{ type: "voice.call", configuration: { flowId: retainedId, flowVersion: retainedVersion } }] })},'valid',now(),${agentId}::uuid)`;
          return { definitionId, canonicalId, retainedVersion };
        },
        process: async (binding: Binding, trigger: string, priority = 100) => {
          await sql`INSERT INTO automation.tenant_processes(tenant_id,name,enabled,trigger_key,channel,agent_profile_version_id,flow_version_id,priority)
            VALUES(${tenantId}::uuid,${`Fictional process ${randomUUID()}`},true,${trigger},${trigger.startsWith("voice.") ? "voice" : "whatsapp"},${agentId}::uuid,${binding.canonicalId}::uuid,${priority})`;
        },
        approved: async () => {
          await sql`INSERT INTO platform.tenant_configuration_releases(tenant_id,version,status,configuration,created_by_user_id,approved_by_user_id,approved_at)
            VALUES(${tenantId}::uuid,1,'published','{}',${userId}::uuid,${userId}::uuid,now())`;
        },
        invoke: async (scopeTenantId: string = tenantId) => {
          await sql`SET LOCAL ROLE platform_web`;
          await sql`SELECT set_config('app.current_tenant',${scopeTenantId},true),set_config('app.current_user',${userId},true),set_config('app.current_role','owner',true)`;
          state.sql = sql;
          state.failure = undefined;
          const response = await POST(
            new Request("http://localhost/api/voice/real-calls", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                contactId: randomUUID(),
                flowId: retainedId,
                idempotencyKey: "fictional-binding-proof",
                callerGender: "female",
                explicitApproval: true,
              }),
            }),
          );
          assertNoScopeFailure();
          return response;
        },
      };
      await work(sql, fixture);
      throw new RollbackFixture();
    });
  } catch (error) {
    if (!(error instanceof RollbackFixture)) throw error;
  } finally {
    state.sql = undefined;
    await db.end({ timeout: 2 });
  }
}

describe.skipIf(!databaseUrl)(
  "real-call routing uses approved tenant processes under platform_web",
  () => {
    const fetcher = vi.fn();
    beforeEach(() => {
      vi.stubEnv("ENABLE_REAL_TELEPHONY", "true");
      vi.stubEnv("ENABLE_REAL_VOICE_PROVIDERS", "true");
      fetcher.mockReset().mockResolvedValue(Response.json({ created: true }));
      vi.stubGlobal("fetch", fetcher);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });
    const expectVersion = (version: number) => {
      expect(fetcher).toHaveBeenCalledOnce();
      const [, init] = fetcher.mock.calls[0] as [URL, RequestInit];
      if (typeof init.body !== "string")
        throw new Error("Missing dispatcher body");
      expect(JSON.parse(init.body)).toMatchObject({ flow_version: version });
    };
    it("preserves the WhatsApp flow while using the distinct approved outbound voice flow", async () =>
      isolated(async (_sql, f) => {
        const old = await f.binding(1),
          current = await f.binding(3);
        await f.process(old, "whatsapp.new_conversation");
        await f.process(current, "voice.outbound_assignment");
        await f.approved();
        expect((await f.invoke()).status).toBe(200);
        expectVersion(3);
      }));
    it("uses the exact approved process pin despite a newer published canonical version", async () =>
      isolated(async (_sql, f) => {
        const pinned = await f.binding(1);
        await f.binding(3, pinned);
        await f.process(pinned, "voice.outbound_assignment");
        await f.approved();
        expect((await f.invoke()).status).toBe(200);
        expectVersion(1);
      }));
    it("ranks fallback versions after approval filtering", async () =>
      isolated(async (_sql, f) => {
        const approved = await f.binding(1);
        await f.binding(3, approved);
        await f.process(approved, "voice.inbound");
        await f.approved();
        expect((await f.invoke()).status).toBe(200);
        expectVersion(1);
      }));
    it("honors outbound priority when several approved processes exist", async () =>
      isolated(async (_sql, f) => {
        const old = await f.binding(1),
          current = await f.binding(3);
        await f.process(old, "voice.outbound_assignment", 200);
        await f.process(current, "voice.outbound_assignment", 10);
        await f.approved();
        expect((await f.invoke()).status).toBe(200);
        expectVersion(3);
      }));
    it("refuses a WhatsApp-only approval before contacting the dispatcher", async () =>
      isolated(async (_sql, f) => {
        await f.process(await f.binding(1), "whatsapp.new_conversation");
        await f.approved();
        expect((await f.invoke()).status).toBe(400);
        expect(fetcher).not.toHaveBeenCalled();
      }));
    it("refuses a disabled voice feature before contacting the dispatcher", async () =>
      isolated(async (sql, f) => {
        await f.binding(1);
        await sql`UPDATE platform.tenant_feature_entitlements SET enabled=false WHERE tenant_id=${f.tenantId}::uuid AND feature_key='voice'`;
        expect((await f.invoke()).status).toBe(400);
        expect(fetcher).not.toHaveBeenCalled();
      }));
    it("retains ambiguity denial for competing unpinned eligible flows", async () =>
      isolated(async (_sql, f) => {
        await f.binding(1);
        await f.binding(3);
        expect((await f.invoke()).status).toBe(400);
        expect(fetcher).not.toHaveBeenCalled();
      }));
    it("does not reuse another tenant's approved binding", async () =>
      isolated(async (sql, f) => {
        await f.process(await f.binding(3), "voice.outbound_assignment");
        await f.approved();
        const foreign = randomUUID();
        await sql`INSERT INTO tenants(id,name,slug,status) VALUES(${foreign}::uuid,'Other fictional tenant',${foreign},'active')`;
        expect((await f.invoke(foreign)).status).toBe(400);
        expect(fetcher).not.toHaveBeenCalled();
      }));
  },
);
