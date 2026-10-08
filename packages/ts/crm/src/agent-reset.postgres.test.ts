import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  createAgentProfileDraft,
  publishAgentProfile,
  rebindAgentConversations,
} from "./cross-channel.js";
import type { JsonValue } from "./types.js";
import { defaultAgentQuality } from "./agent-quality.js";
import {
  inspectAgentReset,
  prepareAgentReset,
  publishPreparedAgentReset,
  activatePreparedAgentReset,
  rollbackPreparedAgentReset,
  type AgentResetPlan,
} from "./agent-reset.js";

const databaseUrl = process.env.CRM_TEST_DATABASE_URL;
class Rollback extends Error {}
function identifier(value: unknown): string {
  if (typeof value !== "string") throw new Error("missing prepared identity");
  return value;
}

describe.skipIf(!databaseUrl)(
  "reviewed reset under application-role RLS",
  () => {
    it("prepares once, preserves history, rejects stale input and another tenant", async () => {
      const url = new URL(databaseUrl ?? "");
      if (!["127.0.0.1", "localhost"].includes(url.hostname))
        throw new Error("local PostgreSQL required");
      const db = postgres(url.toString(), { max: 1 });
      const manifest = JSON.parse(
        readFileSync(
          new URL(
            "../../../../infra/tenant-configurations/oron.whatsapp-lead.agent.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as Pick<
        AgentResetPlan,
        | "systemPrompt"
        | "fields"
        | "capabilities"
        | "name"
        | "maxResponseTokens"
        | "publicationPolicies"
      >;
      try {
        await db
          .begin(async (sql) => {
            const tenant = randomUUID(),
              actor = randomUUID(),
              voice = randomUUID();
            await sql`INSERT INTO public.tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Fictional discovery',${`reset-${tenant}`},'active')`;
            await sql`INSERT INTO public.users(id,email,display_name,status,is_superuser) VALUES(${actor}::uuid,${`reset-${actor}@example.invalid`},'Fictional owner','active',true)`;
            await sql`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${actor}::uuid,'owner')`;
            await sql`INSERT INTO crm.tenant_settings(tenant_id,support_profile) VALUES(${tenant}::uuid,${sql.json({ businessDescription: "Fictional automation", productsAndServices: ["Fictional WhatsApp automation"] })})`;
            await sql`UPDATE platform.tenant_feature_entitlements SET enabled=(feature_key=ANY(ARRAY['contacts','agents','whatsapp','voice','leads'])) WHERE tenant_id=${tenant}::uuid`;
            const voiceSpec = JSON.parse(
              readFileSync(
                new URL(
                  "../../../../infra/tenant-configurations/shared-agent.voice-flow.json",
                  import.meta.url,
                ),
                "utf8",
              ),
            ) as Record<string, JsonValue>;
            voiceSpec.id = voice;
            await sql`INSERT INTO public.flows(flow_id,version,tenant_id,source,spec,components_version) VALUES(${voice}::uuid,1,${tenant}::uuid,'{}',${sql.json(voiceSpec)},'shared-agent/1')`;
            await sql`SET LOCAL ROLE platform_web`;
            await sql`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${actor},true),set_config('app.current_role','owner',true)`;
            const profile = await createAgentProfileDraft(sql, actor, {
              name: "Fictional old agent",
              systemPrompt: "Follow the tenant objective.",
              channels: ["voice", "whatsapp"],
            });
            const [base] = await sql<
              { id: string }[]
            >`SELECT id FROM agents.agent_profile_versions WHERE agent_profile_id=${profile}::uuid`;
            if (!base) throw new Error("missing fixture version");
            await sql`UPDATE agents.agent_profile_versions SET channel_configuration=channel_configuration ||
              ${sql.json({ quality: JSON.parse(JSON.stringify(defaultAgentQuality)) as JsonValue })}
              WHERE id=${base.id}::uuid`;
            await publishAgentProfile(sql, actor, profile, base.id);
            const channel = randomUUID(),
              contact = randomUUID(),
              pinnedChat = randomUUID(),
              humanChat = randomUUID(),
              humanContact = randomUUID(),
              activeCall = randomUUID();
            await sql`RESET ROLE`;
            await sql`INSERT INTO crm.contacts(id,tenant_id,name) VALUES(${contact}::uuid,${tenant}::uuid,'Fictional caller')`;
            await sql`INSERT INTO messaging.channels(id,tenant_id,kind,provider,provider_account_id,status) VALUES(${channel}::uuid,${tenant}::uuid,'whatsapp','simulator',${channel},'active')`;
            await sql`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at) VALUES(${pinnedChat}::uuid,${tenant}::uuid,${channel}::uuid,${contact}::uuid,'ai',${base.id}::uuid,${actor}::uuid,now())`;
            await sql`INSERT INTO crm.contacts(id,tenant_id,name) VALUES(${humanContact}::uuid,${tenant}::uuid,'Fictional human conversation')`;
            await sql`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,ownership_mode) VALUES(${humanChat}::uuid,${tenant}::uuid,${channel}::uuid,${humanContact}::uuid,'human')`;
            await sql`INSERT INTO public.sessions(session_id,tenant_id,direction,room,flow_id,provider,status) VALUES(${activeCall}::uuid,${tenant}::uuid,'inbound',${activeCall},${voice}::uuid,'livekit','started')`;
            await sql`INSERT INTO public.session_events(tenant_id,session_id,sequence,event_type,payload) VALUES(${tenant}::uuid,${activeCall}::uuid,0,'voice.agent.binding.v1',${sql.json({ agent_version_id: base.id })})`;
            await sql`SET LOCAL ROLE platform_web`;
            const [pin] = await sql<
              { ownership_epoch: string }[]
            >`SELECT ownership_epoch::text FROM messaging.conversations WHERE id=${pinnedChat}::uuid`;
            if (!pin) throw new Error("missing synthetic pin");
            let plan: AgentResetPlan = {
              ...manifest,
              publicationPolicies: {
                ...manifest.publicationPolicies,
                processes: {
                  ...manifest.publicationPolicies?.processes,
                  "voice.outbound_assignment": "pinned",
                },
              },
              tenantId: tenant,
              operationId: randomUUID(),
              profileId: profile,
              expectedAgentVersionId: base.id,
              expectedReleaseId: null,
              expectedReleaseRevision: null,
              expectedCatalogSha256: "",
              voiceFlowId: voice,
              voiceFlowVersion: 1,
              expectedVoiceSpecSha256: "",
            };
            const inventory = await inspectAgentReset(sql, plan);
            expect(
              inventory.bindingImpacts.find(
                (p) => p.trigger === "voice.inbound",
              )?.after,
            ).toEqual({
              processPolicy: "follow_published",
              canonicalAgentPolicy: "follow_published",
              retainedVoicePolicy: "follow_published",
              nodeAgentPolicy: "follow_published",
            });
            expect(
              inventory.bindingImpacts.find(
                (p) => p.trigger === "voice.outbound_assignment",
              )?.after.processPolicy,
            ).toBe("pinned");
            const conservative = await inspectAgentReset(sql, {
              ...plan,
              publicationPolicies: {},
            });
            expect(
              conservative.bindingImpacts.every((p) =>
                Object.values(p.after).every((value) => value === "pinned"),
              ),
            ).toBe(true);
            plan = {
              ...plan,
              expectedCatalogSha256: inventory.catalogSha256,
              expectedVoiceSpecSha256: inventory.voiceSpecSha256 ?? "",
            };
            const first = await prepareAgentReset(sql, actor, plan);
            const [composed] = await sql<
              { text: string }[]
            >`SELECT channel_configuration->>'voiceInstructions' AS text FROM agents.agent_profile_versions WHERE id=${identifier(first.agentVersionId)}::uuid`;
            expect(composed?.text).toContain(manifest.systemPrompt);
            expect(composed?.text).toContain("durable");
            expect(
              (
                await sql`SELECT channel_configuration->'quality'->'budgets'->>'maxResponseTokens' AS tokens
              FROM agents.agent_profile_versions WHERE id=${identifier(first.agentVersionId)}::uuid`
              )[0]?.tokens,
            ).toBe("2048");
            expect(
              (
                await sql`SELECT channel_configuration->'quality'->'budgets'->>'maxResponseTokens' AS tokens
              FROM agents.agent_profile_versions WHERE id=${base.id}::uuid`
              )[0]?.tokens,
            ).toBe("256");
            expect(await prepareAgentReset(sql, actor, plan)).toEqual(first);
            expect(
              await sql`SELECT id FROM agents.agent_profile_versions WHERE agent_profile_id=${profile}::uuid`,
            ).toHaveLength(2);
            expect(
              (
                await sql`SELECT published_at FROM agents.agent_profile_versions WHERE id=${base.id}::uuid`
              )[0]?.published_at,
            ).not.toBeNull();
            await expect(
              prepareAgentReset(sql, actor, {
                ...plan,
                systemPrompt: "changed",
              }),
            ).rejects.toThrow("content changed");
            await expect(
              prepareAgentReset(sql, actor, {
                ...plan,
                operationId: randomUUID(),
              }),
            ).rejects.toThrow("revisions changed");
            await expect(
              inspectAgentReset(sql, { ...plan, tenantId: randomUUID() }),
            ).rejects.toThrow("tenant mismatch");
            const version = identifier(first.agentVersionId),
              definition = identifier(first.flowDefinitionId);
            await publishPreparedAgentReset(
              sql,
              actor,
              profile,
              version,
              definition,
            );
            await publishPreparedAgentReset(
              sql,
              actor,
              profile,
              version,
              definition,
            );
            const [flow] = await sql<
              { id: string }[]
            >`SELECT id FROM automation.flow_versions WHERE flow_definition_id=${definition}::uuid`;
            if (!flow) throw new Error("missing prepared flow");
            const activated = await activatePreparedAgentReset(
              sql,
              actor,
              plan,
              version,
              flow.id,
              false,
            );
            expect(
              await activatePreparedAgentReset(
                sql,
                actor,
                plan,
                version,
                flow.id,
                false,
              ),
            ).toEqual(activated);
            expect(
              await sql`SELECT DISTINCT agent_profile_version_id FROM automation.tenant_processes WHERE enabled`,
            ).toEqual([{ agent_profile_version_id: version }]);
            const retained = await inspectAgentReset(sql, plan);
            expect(
              retained.bindingImpacts.find((p) => p.trigger === "voice.inbound")
                ?.before[0],
            ).toMatchObject({
              processPolicy: "follow_published",
              canonicalAgentPolicy: "follow_published",
              voiceNodes: [
                {
                  retainedVoicePolicy: "follow_published",
                  nodeAgentPolicy: "follow_published",
                },
              ],
            });
            expect(
              retained.bindingImpacts.find(
                (p) => p.trigger === "voice.outbound_assignment",
              )?.before[0]?.processPolicy,
            ).toBe("pinned");
            expect(retained.activeCalls).toBe(1);
            expect(retained.owners).toContainEqual({
              mode: "ai",
              version: base.id,
              count: 1,
            });
            expect(retained.owners).toContainEqual({
              mode: "human",
              version: null,
              count: 1,
            });
            expect(
              (
                await sql`SELECT ownership_epoch::text FROM messaging.conversations WHERE id=${pinnedChat}::uuid`
              )[0]?.ownership_epoch,
            ).toBe(pin.ownership_epoch);
            await rebindAgentConversations(sql, actor, profile, version);
            const [rebound] = await sql<
              { ai_agent_profile_version_id: string; ownership_epoch: string }[]
            >`SELECT ai_agent_profile_version_id,ownership_epoch::text FROM messaging.conversations WHERE id=${pinnedChat}::uuid`;
            expect(rebound?.ai_agent_profile_version_id).toBe(version);
            expect(BigInt(rebound?.ownership_epoch ?? "0")).toBeGreaterThan(
              BigInt(pin.ownership_epoch),
            );
            expect(
              (
                await sql`SELECT ownership_mode FROM messaging.conversations WHERE id=${humanChat}::uuid`
              )[0]?.ownership_mode,
            ).toBe("human");
            await sql`RESET ROLE`;
            await sql`SET LOCAL ROLE platform_voice`;
            expect(
              (
                await sql`SELECT payload->>'agent_version_id' AS pinned FROM public.session_events WHERE session_id=${activeCall}::uuid AND event_type='voice.agent.binding.v1'`
              )[0]?.pinned,
            ).toBe(base.id);
            await sql`RESET ROLE`;
            await sql`SET LOCAL ROLE platform_web`;
            await expect(
              sql.savepoint(async (gated) => {
                await gated`SELECT platform.set_agent_quality_gate(true)`;
                const current = await inspectAgentReset(gated, plan);
                const nextPlan = {
                  ...plan,
                  operationId: randomUUID(),
                  expectedAgentVersionId: version,
                  expectedReleaseId: current.configuration.active?.id ?? null,
                  expectedReleaseRevision:
                    current.configuration.active?.revision ?? null,
                };
                const candidate = await prepareAgentReset(
                  gated,
                  actor,
                  nextPlan,
                );
                await publishPreparedAgentReset(
                  gated,
                  actor,
                  profile,
                  identifier(candidate.agentVersionId),
                  identifier(candidate.flowDefinitionId),
                );
              }),
            ).rejects.toThrow(/golden|evidence|evaluation/iu);
            const rollbackOperation = randomUUID();
            const activeRelease = identifier(retained.configuration.active?.id);
            await expect(
              rollbackPreparedAgentReset(
                sql,
                actor,
                plan,
                randomUUID(),
                rollbackOperation,
              ),
            ).rejects.toThrow("Configuration changed");
            const rolledBack = await rollbackPreparedAgentReset(
              sql,
              actor,
              plan,
              activeRelease,
              rollbackOperation,
            );
            expect(
              await rollbackPreparedAgentReset(
                sql,
                actor,
                plan,
                activeRelease,
                rollbackOperation,
              ),
            ).toEqual(rolledBack);
            const restored = await inspectAgentReset(sql, plan);
            expect(restored.configuration.active?.configuration).toEqual(
              inventory.configuration.initialConfiguration,
            );
            expect(restored.configuration.active?.id).not.toBe(activeRelease);
            expect(restored.activeCalls).toBe(1);
            expect(restored.owners).toContainEqual({
              mode: "human",
              version: null,
              count: 1,
            });
            expect(restored.owners).toContainEqual({
              mode: "ai",
              version,
              count: 1,
            });
            if (process.env.AGENT_RESET_EVIDENCE_PATH)
              writeFileSync(
                process.env.AGENT_RESET_EVIDENCE_PATH,
                JSON.stringify(
                  {
                    fixture: "synthetic; transaction rolled back",
                    before: inventory,
                    prepared: first,
                    activated,
                    retainedAfterDefaultCutover: retained,
                    explicitRebind: rebound,
                    rollback: rolledBack,
                  },
                  null,
                  2,
                ),
                { flag: "wx" },
              );
            throw new Rollback();
          })
          .catch((error: unknown) => {
            if (!(error instanceof Rollback)) throw error;
          });
      } finally {
        await db.end();
      }
    });
  },
);
