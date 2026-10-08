import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  rebindAgentConversations,
  listAgentProfiles,
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
import {
  requestAgentGoldenEvaluation,
  getAgentGoldenWorkspace,
} from "./agent-quality-gate.js";
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
      {
        id: string;
      }[]
    >`SELECT id FROM agents.agent_profile_versions WHERE agent_profile_id=${profile}::uuid`;
    await publishAgentProfile(sql, actor, profile, required(base).id);
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
      required(base).id,
      flow,
    );
    await publishCanonicalFlow(sql, actor, definition);
    const [fv] = await sql<
      {
        id: string;
      }[]
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
      agentProfileVersionId: required(base).id,
      flowVersionId: required(fv).id,
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
    let draft = required((await getTenantConfigurationState(sql)).draft);
    await transitionTenantConfiguration(
      sql,
      "submit",
      draft.revision,
      "fixture",
      randomUUID(),
    );
    draft = required((await getTenantConfigurationState(sql)).draft);
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
      base: required(base).id,
      definition,
      flowId: required(fv).id,
      flow,
    };
  });
}
describe.skipIf(!url)("publication bundle under application roles", () => {
  it("atomically advances distinct following triggers, preserves pins/history, rejects stale edits, and repeats once", async () => {
    const u = new URL(required(url));
    if (
      !["localhost", "127.0.0.1"].includes(u.hostname) ||
      !/^\/oron_crm_[a-f0-9]+$/.test(u.pathname)
    )
      throw new Error("disposable local DB required");
    const db = postgres(required(url), { max: 4 });
    try {
      const f = await fixture(db);
      const channel = randomUUID(),
        contact = randomUUID(),
        removedContact = randomUUID(),
        chat = randomUUID(),
        removed = randomUUID(),
        activeCall = randomUUID();
      await db.begin(async (sql) => {
        await sql`INSERT INTO messaging.channels(id,tenant_id,kind,provider,provider_account_id,status)VALUES(${channel}::uuid,${f.tenant}::uuid,'whatsapp','simulator',${channel},'active')`;
        await sql`INSERT INTO crm.contacts(id,tenant_id,name)VALUES(${contact}::uuid,${f.tenant}::uuid,'Fictional existing'),(${removedContact}::uuid,${f.tenant}::uuid,'Fictional removed')`;
        await sql`SELECT set_config('app.current_tenant',${f.tenant},true),set_config('app.current_user',${f.actor},true),set_config('app.current_role','owner',true)`;
        await sql`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at)VALUES(${chat}::uuid,${f.tenant}::uuid,${channel}::uuid,${contact}::uuid,'ai',${f.base}::uuid,${f.actor}::uuid,now()),(${removed}::uuid,${f.tenant}::uuid,${channel}::uuid,${removedContact}::uuid,'ai',${f.base}::uuid,${f.actor}::uuid,now())`;
        await sql`UPDATE messaging.conversations SET removed_from_inbox_at=now() WHERE id=${removed}::uuid`;
        await sql`INSERT INTO public.sessions(session_id,tenant_id,direction,room,flow_id,provider,status)VALUES(${activeCall}::uuid,${f.tenant}::uuid,'inbound',${activeCall},${f.voice}::uuid,'livekit','started')`;
        await sql`INSERT INTO public.session_events(tenant_id,session_id,sequence,event_type,payload)VALUES(${f.tenant}::uuid,${activeCall}::uuid,0,'voice.agent.binding.v1',${sql.json({ agent_version_id: f.base })})`;
      });
      const draft = await db.begin(async (sql) => {
        await scope(sql, f.tenant, f.actor);
        return createAgentProfileRevision(sql, f.actor, f.profile, {
          baseVersionId: f.base,
          systemPrompt: "Updated approved opening.",
          channels: ["voice", "whatsapp"],
        });
      });
      const request = {
        expectedVersionId: required(draft).versionId,
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
            .every(
              (x) => x.agent_profile_version_id === required(draft).versionId,
            ),
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
        const [old] =
          await sql`SELECT ai_agent_profile_version_id,ownership_epoch FROM messaging.conversations WHERE id=${chat}::uuid`;
        expect(old?.ai_agent_profile_version_id).toBe(f.base);
        const profiles = await listAgentProfiles(sql);
        expect(
          profiles.find((p) => p.id === f.profile)?.lifecycle.staleConversations,
        ).toBe(1);
        const rebound = await rebindAgentConversations(
          sql,
          f.actor,
          f.profile,
          required(draft).versionId,
        );
        expect(rebound).toMatchObject({
          rebound: 1,
          skipped: 1,
          skippedRemoved: 1,
          skippedHuman: 0,
        });
        const [after] =
          await sql`SELECT ai_agent_profile_version_id,ownership_epoch FROM messaging.conversations WHERE id=${chat}::uuid`;
        expect(after?.ai_agent_profile_version_id).toBe(
          required(draft).versionId,
        );
        expect(Number(after?.ownership_epoch)).toBeGreaterThan(
          Number(old?.ownership_epoch),
        );
        expect(
          (
            await sql`SELECT ai_agent_profile_version_id FROM messaging.conversations WHERE id=${removed}::uuid`
          )[0]?.ai_agent_profile_version_id,
        ).toBe(f.base);
        await sql`SET LOCAL ROLE platform_voice`;
        expect(
          (
            await sql`SELECT payload->>'agent_version_id' AS version FROM public.session_events WHERE session_id=${activeCall}::uuid AND event_type='voice.agent.binding.v1'`
          )[0]?.version,
        ).toBe(f.base);
        await sql`SET LOCAL ROLE platform_web`;
        await expect(
          saveCanonicalFlowDraft(sql, f.actor, f.definition, f.flow, 1),
        ).rejects.toThrow("revision changed");
      });
      // A separate database connection resolves the committed bundle (no process-local current cache).
      const second = postgres(required(url), { max: 1 });
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
    const db = postgres(required(url), { max: 2 });
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
        const draft = required((await getTenantConfigurationState(sql)).draft);
        expect(draft.status).toBe("submitted");
        await transitionTenantConfiguration(
          sql,
          "approve",
          draft.revision,
          "reviewed",
          randomUUID(),
        );
        const [changed] = await sql<
          {
            definition: CanonicalFlow;
          }[]
        >`SELECT definition FROM automation.flow_versions WHERE id=${required(result.impacts.find((x) => x.processName === "Inbound")).newFlowVersionId}::uuid`;
        expect(
          changed?.definition.nodes.find(
            (n: { type: string }) => n.type === "voice.call",
          )?.configuration?.flowVersion,
        ).toBe(2);
      });
    } finally {
      await db.end();
    }
  }, 30000);
  it("rejects a pending review without partially publishing", async () => {
    const db = postgres(required(url), { max: 2 });
    try {
      const f = await fixture(db);
      const draft = await db.begin(async (sql) => {
        await scope(sql, f.tenant, f.actor);
        return createAgentProfileRevision(sql, f.actor, f.profile, {
          baseVersionId: f.base,
          systemPrompt: "New draft",
          channels: ["voice", "whatsapp"],
        });
      });
      await db.begin(async (sql) => {
        await scope(sql, f.tenant, f.actor);
        const state = await getTenantConfigurationState(sql);
        await saveTenantConfigurationDraft(
          sql,
          required(state.active).configuration,
          null,
          randomUUID(),
        );
      });
      await expect(
        db.begin(async (sql) => {
          await scope(sql, f.tenant, f.actor);
          return publishAgentWithBindings(sql, f.actor, f.profile, {
            expectedVersionId: required(draft).versionId,
            requestId: randomUUID(),
            activate: true,
          });
        }),
      ).rejects.toThrow("existing configuration review");
      await db.begin(async (sql) => {
        await scope(sql, f.tenant, f.actor);
        expect(
          (
            await sql`SELECT published_at FROM agents.agent_profile_versions WHERE id=${required(draft).versionId}::uuid`
          )[0]?.published_at,
        ).toBeNull();
        expect(
          (
            await sql`SELECT count(*)::int AS count FROM automation.flow_versions WHERE flow_definition_id=${f.definition}::uuid`
          )[0]?.count,
        ).toBe(1);
      });
    } finally {
      await db.end();
    }
  });
  it("leaves ordinary managers pending and denies their crafted approval without partial activation", async () => {
    const db = postgres(required(url), { max: 2 });
    try {
      const f = await fixture(db);
      await db`UPDATE public.users SET is_superuser=false WHERE id=${f.actor}::uuid`;
      const result = await db.begin(async (sql) => {
        await scope(sql, f.tenant, f.actor);
        const draft = await createAgentProfileRevision(
          sql,
          f.actor,
          f.profile,
          {
            baseVersionId: f.base,
            systemPrompt: "Reviewed by owner",
            channels: ["voice", "whatsapp"],
          },
        );
        return publishAgentWithBindings(sql, f.actor, f.profile, {
          expectedVersionId: required(draft).versionId,
          requestId: randomUUID(),
          activate: true,
        });
      });
      expect(result.status).toBe("published_pending_activation");
      await expect(
        db.begin(async (sql) => {
          await scope(sql, f.tenant, f.actor);
          return activateRetainedPublication(
            sql,
            f.actor,
            result.operationId,
            true,
          );
        }),
      ).rejects.toThrow("configuration review denied");
      await db.begin(async (sql) => {
        await scope(sql, f.tenant, f.actor);
        expect(
          required(
            (await getTenantConfigurationState(sql)).active,
          ).configuration.processes.every(
            (p) => p.agentProfileVersionId === f.base,
          ),
        ).toBe(true);
      });
    } finally {
      await db.end();
    }
  });
  it("an inbound follower advances while the separate outbound pin and runtime fixtures stay exact", async () => {
    const db = postgres(required(url), { max: 2 });
    try {
      const f = await fixture(db);
      const result = await db.begin(async (sql) => {
        await scope(sql, f.tenant, f.actor);
        const state = await getTenantConfigurationState(sql);
        const config = {
          ...required(state.active).configuration,
          processes: required(state.active).configuration.processes.map((p) =>
            p.trigger === "voice.outbound_assignment"
              ? { ...p, bindingPolicy: "pinned" }
              : p,
          ),
        };
        await saveTenantConfigurationDraft(sql, config, null, randomUUID());
        let pending = required((await getTenantConfigurationState(sql)).draft);
        await transitionTenantConfiguration(
          sql,
          "submit",
          pending.revision,
          "explicit pin",
          randomUUID(),
        );
        pending = required((await getTenantConfigurationState(sql)).draft);
        await transitionTenantConfiguration(
          sql,
          "approve",
          pending.revision,
          "explicit pin",
          randomUUID(),
        );
        const draft = await createAgentProfileRevision(
          sql,
          f.actor,
          f.profile,
          {
            baseVersionId: f.base,
            systemPrompt: "New active opening",
            channels: ["voice", "whatsapp"],
          },
        );
        return publishAgentWithBindings(sql, f.actor, f.profile, {
          expectedVersionId: required(draft).versionId,
          requestId: randomUUID(),
          activate: true,
        });
      });
      const incoming = required(
          result.impacts.find((i) => i.trigger === "voice.inbound"),
        ),
        outgoing = required(
          result.impacts.find((i) => i.trigger === "voice.outbound_assignment"),
        );
      expect(incoming.newAgentVersionId).not.toBe(f.base);
      expect(outgoing.newAgentVersionId).toBe(f.base);
      if (process.env.PUBLICATION_CONTEXT_PATH)
        writeFileSync(
          process.env.PUBLICATION_CONTEXT_PATH,
          JSON.stringify({ ...f, newAgent: incoming.newAgentVersionId }),
        );
    } finally {
      await db.end();
    }
  });
  it("stages exact candidate evidence and refuses stale, unrelated and synthetic-only acceptance", async () => {
    const db = postgres(required(url), { max: 2 });
    try {
      const f = await fixture(db);
      const result = await db.begin(async (sql) => {
        await scope(sql, f.tenant, f.actor);
        const draft = await createAgentProfileRevision(
          sql,
          f.actor,
          f.profile,
          {
            baseVersionId: f.base,
            systemPrompt: "Exact evaluated opening",
            channels: ["voice", "whatsapp"],
          },
        );
        await sql`SELECT platform.set_agent_quality_gate(true)`;
        return publishAgentWithBindings(sql, f.actor, f.profile, {
          expectedVersionId: required(draft).versionId,
          requestId: randomUUID(),
          activate: true,
        });
      });
      expect(result.status).toBe("blocked_evaluation");
      expect(result.evaluationCandidates).toHaveLength(1);
      const candidate = required(required(result.evaluationCandidates)[0]);
      let evaluationJob = "";
      let caseId = "";
      await db.begin(async (sql) => {
        await scope(sql, f.tenant, f.actor);
        expect(
          (
            await sql`SELECT published_at FROM agents.agent_profile_versions WHERE id=${candidate.agentVersionId}::uuid`
          )[0]?.published_at,
        ).toBeNull();
        expect(
          required(
            (await getTenantConfigurationState(sql)).active,
          ).configuration.processes.every(
            (p) => p.agentProfileVersionId === f.base,
          ),
        ).toBe(true);
        const cases = Array.from({ length: 30 }, (_, i) => ({
          id: randomUUID(),
          channel: "whatsapp",
          input: `Fictional candidate ${String(i)}`,
          expected: { clarify: true },
        }));
        const [dataset] = await sql<
          {
            id: string;
          }[]
        >`SELECT platform.create_quality_dataset(${f.profile}::uuid,'synthetic_fixture',${sql.json(cases)},'{}'::jsonb) AS id`;
        const body = {
          versionId: candidate.agentVersionId,
          datasetId: required(dataset).id,
          publicationOperationId: result.operationId,
        };
        const job = await requestAgentGoldenEvaluation(sql, f.profile, body);
        evaluationJob = job;
        caseId = required(cases[0]).id;
        expect(await requestAgentGoldenEvaluation(sql, f.profile, body)).toBe(
          job,
        );
        const workspace = await getAgentGoldenWorkspace(
          sql,
          f.profile,
          candidate.agentVersionId,
          result.operationId,
        );
        expect(workspace.evaluations).toMatchObject([
          { id: job, state: "blocked", hasAcceptedReceipt: false },
        ]);
        expect(
          (
            await activateRetainedPublication(
              sql,
              f.actor,
              result.operationId,
              true,
            )
          ).status,
        ).toBe("blocked_evaluation");
        await expect(
          sql.savepoint((nested) =>
            requestAgentGoldenEvaluation(nested, f.profile, {
              ...body,
              versionId: f.base,
            }),
          ),
        ).rejects.toThrow("agent not part of candidate");
      });
      // Only this owned synthetic fixture is made claimable to test the worker boundary.
      // It can never earn a real-data receipt; no provider evidence is fabricated.
      await db`UPDATE agents.quality_evaluation_jobs SET state='pending' WHERE id=${evaluationJob}::uuid`;
      await db.begin(async (sql) => {
        await sql`SET LOCAL ROLE platform_agent_evaluation`;
        const [row] = await sql<
          {
            claim: {
              jobId: string;
              claimToken: string;
              publicationCandidateDigest: string;
              publicationCandidate: {
                resource: {
                  system_prompt: string;
                };
              };
            };
          }[]
        >`SELECT platform.claim_agent_quality_evaluation() AS claim`;
        expect(required(row).claim.jobId).toBe(evaluationJob);
        expect(required(row).claim.publicationCandidateDigest).toBe(
          candidate.candidateDigest,
        );
        expect(
          required(row).claim.publicationCandidate.resource.system_prompt,
        ).toBe("Exact evaluated opening");
        await expect(
          sql.savepoint(
            (nested) =>
              nested`SELECT platform.append_agent_quality_case(${evaluationJob}::uuid,${required(row).claim.claimToken}::uuid,${caseId}::uuid,'{}'::jsonb)`,
          ),
        ).rejects.toThrow(
          "physical case must attest exact publication candidate",
        );
        await expect(
          sql.savepoint(
            (nested) =>
              nested`SELECT platform.finalize_agent_quality_evaluation(${evaluationJob}::uuid,${required(row).claim.claimToken}::uuid)`,
          ),
        ).rejects.toThrow("approved real dataset and policy required");
        await sql`SELECT platform.fail_agent_quality_evaluation(${evaluationJob}::uuid,${required(row).claim.claimToken}::uuid,'synthetic_fixture_only')`;
      });
      // Relevant tenant instructions changing after preparation invalidates this receipt request.
      await db`UPDATE crm.tenant_settings SET support_profile='{"businessDescription":"Changed after candidate"}' WHERE tenant_id=${f.tenant}::uuid`;
      await expect(
        db.begin(async (sql) => {
          await scope(sql, f.tenant, f.actor);
          return activateRetainedPublication(
            sql,
            f.actor,
            result.operationId,
            true,
          );
        }),
      ).rejects.toThrow("candidate changed");
    } finally {
      await db.end();
    }
  }, 30000);
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Expected fixture value");
  return value;
}
