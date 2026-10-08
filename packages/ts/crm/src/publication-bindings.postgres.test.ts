import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  createAgentProfileDraft,
  createAgentProfileRevision,
  createCanonicalFlowDraft,
  publishAgentProfile,
  publishCanonicalFlow,
  type CanonicalFlow,
} from "./cross-channel.js";
import {
  getTenantConfigurationState,
  saveTenantConfigurationDraft,
  transitionTenantConfiguration,
} from "./tenant-configuration.js";
import {
  publishAgentWithBindings,
  activateRetainedPublication,
} from "./publication-bindings.js";
import { saveCanonicalFlowDraft } from "./flow-runtime.js";
const url = process.env.CRM_TEST_DATABASE_URL;
async function scope(
  sql: postgres.TransactionSql,
  tenant: string,
  actor: string,
) {
  await sql`SET LOCAL ROLE platform_web`;
  await sql`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${actor},true),set_config('app.current_role','owner',true)`;
}
async function fixture(db: postgres.Sql) {
  const tenant = randomUUID(),
    actor = randomUUID(),
    voice = randomUUID();
  return db.begin(async (sql) => {
    await sql`INSERT INTO public.tenants(id,name,slug,status)VALUES(${tenant}::uuid,'Fictional publication',${`publication-${tenant}`},'active')`;
    await sql`INSERT INTO public.users(id,email,display_name,status,is_superuser)VALUES(${actor}::uuid,${`${actor}@example.invalid`},'Fictional owner','active',true)`;
    await sql`INSERT INTO public.memberships(tenant_id,user_id,role)VALUES(${tenant}::uuid,${actor}::uuid,'owner')`;
    await sql`INSERT INTO crm.tenant_settings(tenant_id)VALUES(${tenant}::uuid)`;
    await sql`UPDATE platform.tenant_feature_entitlements SET enabled=feature_key=ANY(ARRAY['contacts','agents','voice','whatsapp']) WHERE tenant_id=${tenant}::uuid`;
    await sql`INSERT INTO public.flows(flow_id,version,tenant_id,source,spec,components_version)VALUES(${voice}::uuid,1,${tenant}::uuid,'{}','{}','test')`;
    await scope(sql, tenant, actor);
    const profile = await createAgentProfileDraft(sql, actor, {
      name: "Fictional publication agent",
      systemPrompt: "Help with the approved services.",
      channels: ["voice", "whatsapp"],
    });
    const [base] = await sql<
      { id: string }[]
    >`SELECT id FROM agents.agent_profile_versions WHERE agent_profile_id=${profile}::uuid`;
    await publishAgentProfile(sql, actor, profile, base!.id);
    const flow: CanonicalFlow = {
      schemaVersion: "1.0",
      agentReferencePolicy: "follow_published",
      channels: ["voice", "whatsapp"],
      nodes: [
        { id: "start", type: "start" },
        {
          id: "call",
          type: "voice.call",
          configuration: {
            flowId: voice,
            flowVersion: 1,
            flowReferencePolicy: "follow_published",
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { id: "v1", source: "start", target: "call", channels: ["voice"] },
        { id: "v2", source: "call", target: "end", channels: ["voice"] },
        { id: "w1", source: "start", target: "end", channels: ["whatsapp"] },
      ],
    };
    const definition = await createCanonicalFlowDraft(
      sql,
      actor,
      "Fictional following flow",
      base!.id,
      flow,
    );
    await publishCanonicalFlow(sql, actor, definition);
    const [fv] = await sql<
      { id: string }[]
    >`SELECT id FROM automation.flow_versions WHERE flow_definition_id=${definition}::uuid`;
    const processes = (
      [
        ["Inbound", "voice.inbound", "voice", "follow_published"],
        ["Outbound", "voice.outbound_assignment", "voice", "follow_published"],
        [
          "WhatsApp",
          "whatsapp.new_conversation",
          "whatsapp",
          "follow_published",
        ],
        ["Pinned", "manual.contact_action", "voice", "pinned"],
      ] as const
    ).map(([name, trigger, channel, bindingPolicy]) => ({
      name,
      trigger,
      channel,
      bindingPolicy,
      enabled: true,
      agentProfileVersionId: base!.id,
      flowVersionId: fv!.id,
      requiredFeatures: [],
      priority: 100,
    }));
    await saveTenantConfigurationDraft(
      sql,
      {
        schemaVersion: 1,
        templateKey: null,
        features: ["contacts", "agents", "voice", "whatsapp"],
        featureConfiguration: {},
        processes,
      },
      null,
      randomUUID(),
    );
    let draft = (await getTenantConfigurationState(sql)).draft!;
    await transitionTenantConfiguration(
      sql,
      "submit",
      draft.revision,
      "fixture",
      randomUUID(),
    );
    draft = (await getTenantConfigurationState(sql)).draft!;
    await transitionTenantConfiguration(
      sql,
      "approve",
      draft.revision,
      "fixture",
      randomUUID(),
    );
    return {
      tenant,
      actor,
      voice,
      profile,
      base: base!.id,
      definition,
      flowId: fv!.id,
      flow,
    };
  });
}
describe.skipIf(!url)("publication bundle under application roles", () => {
  it("atomically advances distinct following triggers, preserves pins/history, rejects stale edits, and repeats once", async () => {
    const u = new URL(url!);
    if (
      !["localhost", "127.0.0.1"].includes(u.hostname) ||
      !/^\/oron_crm_[a-f0-9]+$/.test(u.pathname)
    )
      throw new Error("disposable local DB required");
    const db = postgres(url!, { max: 4 });
    try {
      const f = await fixture(db);
      const draft = await db.begin(async (sql) => {
        await scope(sql, f.tenant, f.actor);
        return createAgentProfileRevision(sql, f.actor, f.profile, {
          baseVersionId: f.base,
          systemPrompt: "Updated approved opening.",
          channels: ["voice", "whatsapp"],
        });
      });
      const request = {
        expectedVersionId: draft!.versionId,
        requestId: randomUUID(),
        activate: true,
      };
      const publish = () =>
        db.begin(async (sql) => {
          await scope(sql, f.tenant, f.actor);
          return publishAgentWithBindings(sql, f.actor, f.profile, request);
        });
      const [first, repeat] = await Promise.all([publish(), publish()]);
      expect(repeat).toEqual(first);
      expect(first.status).toBe("active_for_new_interactions");
      expect(
        first.impacts
          .filter((x) => x.status === "active_for_new_interactions")
          .map((x) => x.trigger)
          .sort(),
      ).toEqual([
        "voice.inbound",
        "voice.outbound_assignment",
        "whatsapp.new_conversation",
      ]);
      expect(
        first.impacts.find((x) => x.processName === "Pinned")
          ?.newAgentVersionId,
      ).toBe(f.base);
      await db.begin(async (sql) => {
        await scope(sql, f.tenant, f.actor);
        const routes =
          await sql`SELECT trigger_key,agent_profile_version_id FROM automation.tenant_processes ORDER BY trigger_key`;
        expect(
          routes
            .filter((x) => x.trigger_key !== "manual.contact_action")
            .every((x) => x.agent_profile_version_id === draft!.versionId),
        ).toBe(true);
        expect(
          (
            await sql`SELECT count(*)::int AS count FROM automation.flow_versions WHERE flow_definition_id=${f.definition}::uuid`
          )[0]?.count,
        ).toBe(2);
        expect(
          (
            await sql`SELECT agent_profile_version_id FROM automation.flow_versions WHERE id=${f.flowId}::uuid`
          )[0]?.agent_profile_version_id,
        ).toBe(f.base);
        await expect(
          saveCanonicalFlowDraft(sql, f.actor, f.definition, f.flow, 1),
        ).rejects.toThrow("revision changed");
      });
      // A separate database connection resolves the committed bundle (no process-local current cache).
      const second = postgres(url!, { max: 1 });
      try {
        await second.begin(async (sql) => {
          await scope(sql, f.tenant, f.actor);
          expect((await getTenantConfigurationState(sql)).active?.id).toBe(
            first.releaseId,
          );
        });
      } finally {
        await second.end();
      }
      await expect(
        db.begin(async (sql) => {
          await scope(sql, f.tenant, f.actor);
          return publishAgentWithBindings(sql, f.actor, f.profile, {
            ...request,
            requestId: randomUUID(),
          });
        }),
      ).rejects.toThrow();
      const other = await fixture(db);
      await db.begin(async (sql) => {
        await scope(sql, other.tenant, other.actor);
        expect(
          await sql`SELECT id FROM automation.publication_operations WHERE id=${request.requestId}::uuid`,
        ).toHaveLength(0);
      });
    } finally {
      await db.end();
    }
  }, 30000);
  it("stages retained source and advances its followers once; published stays pending without activation", async () => {
    const db = postgres(url!, { max: 2 });
    try {
      const f = await fixture(db);
      const operation = randomUUID();
      await db.begin(async (sql) => {
        await sql`INSERT INTO public.flows(flow_id,version,tenant_id,source,spec,components_version)VALUES(${f.voice}::uuid,2,${f.tenant}::uuid,'{}','{}','test')`;
        await scope(sql, f.tenant, f.actor);
        await sql`INSERT INTO automation.publication_operations(tenant_id,id,kind,resource_id,candidate_version,request_hash,result,created_by_user_id)VALUES(${f.tenant}::uuid,${operation}::uuid,'retained_voice',${f.voice}::uuid,2,${"a".repeat(64)},${sql.json({ status: "published_pending_activation", operationId: operation, releaseId: null, impacts: [] })},${f.actor}::uuid)`;
        const result = await activateRetainedPublication(
          sql,
          f.actor,
          operation,
          false,
        );
        expect(result.status).toBe("published_pending_activation");
        expect(
          (await getTenantConfigurationState(sql)).active?.configuration
            .processes[0]?.flowVersionId,
        ).toBe(f.flowId);
        expect(
          await activateRetainedPublication(sql, f.actor, operation, false),
        ).toEqual(result);
        const draft = (await getTenantConfigurationState(sql)).draft!;
        expect(draft.status).toBe("submitted");
        await transitionTenantConfiguration(
          sql,
          "approve",
          draft.revision,
          "reviewed",
          randomUUID(),
        );
        const [changed] =
          await sql`SELECT definition FROM automation.flow_versions WHERE id=${result.impacts.find((x) => x.processName === "Inbound")!.newFlowVersionId}::uuid`;
        expect(
          changed?.definition.nodes.find(
            (n: { type: string }) => n.type === "voice.call",
          ).configuration.flowVersion,
        ).toBe(2);
      });
    } finally {
      await db.end();
    }
  }, 30000);
});
