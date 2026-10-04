import { createFairDatabaseFixture } from "./fair-database-fixture.js";
import {
  createModelCredentialResolver,
  sealModelCredential,
} from "../src/model-credentials.js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createAgentProfileDraft } from "@or-on/crm";
import { createMessagingStore } from "../src/database.js";
import {
  SimulatorWhatsAppProvider,
  type WhatsAppSendRequest,
} from "../src/providers.js";
import type { WhatsAppAiRequest } from "../src/ai-provider.js";

const url = process.env.FAIR_TEST_DATABASE_URL;
describe.skipIf(!url)(
  "actual worker session admission and tenant fairness",
  () => {
    it.each(["positive", "revoked", "boundBackground"] as const)(
      "selects latest eligible same-profile revision with both flags and summary %s",
      async (scenario) => {
        if (!url) throw new Error("Owned fair fixture required");
        const fixtureDatabase = await createFairDatabaseFixture(url);
        const admin = postgres(fixtureDatabase.url, { max: 2, prepare: false });
        const fixtures: {
          tenant: string;
          account: string;
          from: string;
          conversation: string;
        }[] = [];
        let releaseSlow: () => void = () => {
          throw new Error("uninitialized slow model");
        };
        const slow = new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
        const state = { aStarted: false };
        const modelCalls: string[] = [];
        const sent: string[] = [];
        const summarySources: number[] = [];
        const summaryKey = Buffer.alloc(32, 19);
        const resolveSealedCredential = createModelCredentialResolver(
          new Map([["synthetic-summary:v2", summaryKey]]),
        );
        let releaseSummary: () => void = () => undefined;
        const summaryGate = new Promise<void>((resolve) => {
          releaseSummary = resolve;
        });
        const summaryState = { held: false };
        let physicalSummaryRequests = 0;
        const workerTarget = new URL(fixtureDatabase.url);
        workerTarget.searchParams.set("options", "-c role=platform_messaging");
        const model = {
          decide: async (request: WhatsAppAiRequest) => {
            const label = request.contactContext?.contact.name ?? "missing";
            expect(request.systemPrompt).toBe("New session eligible prompt");
            modelCalls.push(label);
            if (label === "Synthetic A") {
              state.aStarted = true;
              await slow;
            }
            return { action: "reply" as const, text: "Hello! How can I help?" };
          },
        };
        const meta = {
          name: "meta" as const,
          send: async (request: WhatsAppSendRequest) => {
            await request.beforeAttempt?.();
            sent.push(request.recipient);
            return { messageId: `synthetic-send-${randomUUID()}` };
          },
        };
        const stores = ["one", "two"].map((label) =>
          createMessagingStore(
            workerTarget.toString(),
            `fair-worker-${label}`,
            { simulator: new SimulatorWhatsAppProvider(), meta },
            undefined,
            {
              aiProvider: model,
              realWhatsAppEnabled: true,
              ...(scenario === "boundBackground"
                ? {
                    modelRouting: {
                      resolveSealedCredential,
                      createProvider: () => model,
                    },
                    memorySummaryFetch: async (
                      _input: RequestInfo | URL,
                      init?: RequestInit,
                    ) => {
                      physicalSummaryRequests++;
                      expect(init?.redirect).toBe("error");
                      if (typeof init?.body !== "string")
                        throw new TypeError("Missing synthetic body");
                      const body = JSON.parse(init.body) as {
                        tools?: unknown;
                        messages: { content: string }[];
                      };
                      expect(body.tools).toBeUndefined();
                      const turnBody = body.messages[1]?.content;
                      if (!turnBody)
                        throw new TypeError("Missing synthetic turns");
                      const parsed: unknown = JSON.parse(turnBody);
                      if (!Array.isArray(parsed))
                        throw new TypeError("Invalid synthetic turns");
                      summarySources.push(parsed.length);
                      if (physicalSummaryRequests === 1) {
                        summaryState.held = true;
                        await summaryGate;
                      }
                      return Response.json({
                        choices: [
                          {
                            message: {
                              content: "Synthetic customer assertions only.",
                            },
                          },
                        ],
                        usage: { prompt_tokens: 30, completion_tokens: 8 },
                      });
                    },
                  }
                : {
                    memorySummaryProvider: {
                      summarize: async ({ customerTurns }) => {
                        summarySources.push(customerTurns.length);
                        if (
                          scenario === "revoked" &&
                          summarySources.length === 1
                        ) {
                          await admin`UPDATE public.users SET status='inactive' WHERE id=(
                SELECT conversation.ai_enabled_by_user_id FROM messaging.conversations conversation
                JOIN messaging.messages message ON message.conversation_id=conversation.id
                  AND message.tenant_id=conversation.tenant_id
                WHERE message.id=${customerTurns[0]?.id ?? randomUUID()}::uuid)`;
                        }

                        expect(
                          customerTurns.every(
                            (turn) => turn.source === "customer",
                          ),
                        ).toBe(true);
                        return "Synthetic shadow customer summary; no action receipts.";
                      },
                    },
                  }),
            },
          ),
        );
        try {
          const firstStore = stores[0];
          const secondStore = stores[1];
          if (!firstStore || !secondStore)
            throw new Error("Two worker stores required");
          expect(await firstStore.isReady()).toBe(true);
          await admin`revoke execute on function ops.claim_fair_ai_reply(text) from platform_messaging`;
          try {
            expect(await firstStore.isReady()).toBe(false);
          } finally {
            await admin`grant execute on function ops.claim_fair_ai_reply(text) to platform_messaging`;
          }
          expect(await firstStore.isReady()).toBe(true);
          for (let index = 0; index < 2; index++) {
            const tenant = randomUUID(),
              user = randomUUID(),
              channel = randomUUID(),
              contact = randomUUID(),
              conversation = randomUUID();
            const account = `synthetic-account-${randomUUID()}`,
              from = `1202555000${String(index)}`;
            await admin.begin(async (tx) => {
              await tx`insert into public.tenants(id,name,slug,status) values(${tenant}::uuid,${index === 0 ? "Synthetic A tenant" : "Synthetic B tenant"},${`fair-worker-${tenant}`},'active')`;
              await tx`insert into public.users(id,email,status) values(${user}::uuid,${`${user}@example.invalid`},'active')`;
              await tx`insert into public.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner')`;
              await tx`select set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${user},true),set_config('app.current_role','owner',true)`;
              await tx`insert into crm.tenant_settings(tenant_id,locale,timezone) values(${tenant}::uuid,'en','UTC')`;
              await tx`insert into platform.tenant_remediation_flags(tenant_id,flag_key,enabled) values(${tenant}::uuid,'queue_priority',true),(${tenant}::uuid,'session_memory',true)`;
              await tx`insert into messaging.channels(id,tenant_id,kind,provider,provider_account_id,display_address,status,configuration) values(${channel}::uuid,${tenant}::uuid,'whatsapp','meta',${account},'Synthetic account','active',${tx.json({ phoneNumberId: account, wabaId: "synthetic-waba", graphApiVersion: "v26.0" })})`;
              await tx`insert into crm.contacts(id,tenant_id,created_by_user_id,name,whatsapp_consent) values(${contact}::uuid,${tenant}::uuid,${user}::uuid,${index === 0 ? "Synthetic A" : "Synthetic B"},'granted')`;
              await tx`insert into crm.contact_channel_identities(tenant_id,contact_id,channel,normalized_value,display_value,validation_status,is_primary) values(${tenant}::uuid,${contact}::uuid,'whatsapp',${"+" + from},${"+" + from},'valid',true)`;
              const profile = await createAgentProfileDraft(tx, user, {
                name: "Synthetic fairness agent",
                systemPrompt: "Help customers safely.",
                locale: "en",
                channels: ["whatsapp"],
              });
              const versions = await tx<
                { id: string }[]
              >`update agents.agent_profile_versions set published_at=clock_timestamp(),validation_status='valid' where agent_profile_id=${profile}::uuid returning id`;
              const version = versions[0]?.id;
              if (!version) throw new Error("Synthetic agent version absent");
              let summaryConfiguration: string | null = null;
              if (scenario === "boundBackground") {
                summaryConfiguration = randomUUID();
                const credential = randomUUID();
                const sealed = sealModelCredential(
                  {
                    tenantId: tenant,
                    modelConfigurationId: summaryConfiguration,
                    credentialId: credential,
                    provider: "openai",
                  },
                  "synthetic-summary-token",
                  summaryKey,
                  "synthetic-summary:v2",
                );
                await tx`INSERT INTO platform.credential_records(id,tenant_id,kind,algorithm,key_version,ciphertext,nonce) VALUES(${credential}::uuid,${tenant}::uuid,${sealed.kind},${sealed.algorithm},${sealed.keyVersion},decode(${sealed.ciphertext},'hex'),decode(${sealed.nonce},'hex'))`;
                await tx`INSERT INTO agents.model_configurations(id,tenant_id,name,provider,model,credential_id,settings,daily_request_limit,is_enabled) VALUES(${summaryConfiguration}::uuid,${tenant}::uuid,'Synthetic summary model','openai','synthetic-summary-model',${credential}::uuid,'{}',20,true)`;
              }
              await tx`insert into agents.agent_profile_versions(tenant_id,agent_profile_id,version,system_prompt,locale,channel_capabilities,tool_permissions,validation_status,created_by_user_id,published_at,model_configuration_id)
            values(${tenant}::uuid,${profile}::uuid,2,'New session eligible prompt','en',ARRAY['whatsapp'],'[]'::jsonb,'valid',${user}::uuid,clock_timestamp(),${summaryConfiguration}::uuid)`;
              await tx`insert into messaging.conversations(id,tenant_id,channel_id,contact_id,status,ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at) values(${conversation}::uuid,${tenant}::uuid,${channel}::uuid,${contact}::uuid,'open','ai',${version}::uuid,${user}::uuid,clock_timestamp())`;
            });
            fixtures.push({ tenant, account, from, conversation });
          }
          const accept = async (index: number) => {
            const fixture = fixtures[index];
            if (!fixture) throw new Error("Missing synthetic tenant");
            const message = randomUUID();
            await admin`select ops.accept_whatsapp_inbound(${fixture.account},${message},'whatsapp.message.text',${admin.json({ providerAccountId: fixture.account, providerEventId: message, providerMessageId: message, from: "+" + fixture.from, profileName: index === 0 ? "Synthetic A" : "Synthetic B", text: "Hi!", contentType: "text", occurredAt: new Date().toISOString() })})`;
          };
          await accept(0);
          await firstStore.processAvailable();
          // The scheduler returns before asynchronous credential/route admission finishes.
          const startDeadline = Date.now() + 5000;
          while (!state.aStarted && Date.now() < startDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(state.aStarted).toBe(true);
          await accept(1);
          let bSent = false;
          for (let pass = 0; pass < 30; pass++) {
            await Promise.all(stores.map((store) => store.processAvailable()));
            bSent = sent.some((recipient) => recipient.includes("12025550001"));
            if (bSent) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(bSent).toBe(true);
          expect(
            sent.filter((recipient) => recipient.includes("12025550001")),
          ).toHaveLength(1);
          expect(
            sent.some((recipient) => recipient.includes("12025550000")),
          ).toBe(false);
          expect(
            modelCalls.filter((label) => label === "Synthetic A"),
          ).toHaveLength(1);
          expect(
            modelCalls.filter((label) => label === "Synthetic B"),
          ).toHaveLength(1);
          const b = fixtures[1];
          if (!b) throw new Error("Missing B");
          const visible = await admin<
            { count: string }[]
          >`select count(*) from messaging.messages where tenant_id=${b.tenant}::uuid and direction='inbound'`;
          expect(Number(visible[0]?.count)).toBe(1);
          releaseSlow();
          await Promise.all(stores.map((store) => store.drainReplies()));
          for (const fixture of fixtures) {
            const rows = await admin<{ version: number; admissions: string }[]>`
          select version.version,(select count(*)::text from agents.messaging_session_admissions admission where admission.tenant_id=conversation.tenant_id) as admissions
          from messaging.conversations conversation join agents.agent_profile_versions version on version.id=conversation.ai_agent_profile_version_id
          where conversation.id=${fixture.conversation}::uuid`;
            expect(rows[0]?.version).toBe(2);
            expect(Number(rows[0]?.admissions)).toBe(1);
            await admin.begin(async (tx) => {
              await tx`SELECT set_config('app.current_tenant',${fixture.tenant},true)`;
              for (let index = 0; index < 10; index++)
                await tx`INSERT INTO messaging.messages(tenant_id,conversation_id,direction,sender_type,content_type,content_text,status)
                VALUES(${fixture.tenant}::uuid,${fixture.conversation}::uuid,'inbound','contact','text',${`Fictional customer ${String(index)}`},'received')`;
              await tx`UPDATE agents.messaging_memory_sessions SET last_activity_at=clock_timestamp()
              WHERE tenant_id=${fixture.tenant}::uuid AND conversation_id=${fixture.conversation}::uuid`;
            });
          }
          for (let pass = 0; pass < 5; pass++)
            await firstStore.processAvailable();
          if (scenario === "boundBackground") {
            for (let pass = 0; pass < 30 && !summaryState.held; pass++) {
              await firstStore.processAvailable();
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(summaryState.held).toBe(true);
            const previouslySent = sent.length;
            await accept(1);
            for (
              let pass = 0;
              pass < 40 && sent.length === previouslySent;
              pass++
            ) {
              await Promise.all(
                stores.map((store) => store.processAvailable()),
              );
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(sent.length).toBeGreaterThan(previouslySent);
            // Drain observes the held durable job rather than abandoning a detached task.
            let drained = false;
            const drain = firstStore.drainReplies().then(() => {
              drained = true;
            });
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(drained).toBe(false);
            releaseSummary();
            await drain;
          }
          await Promise.all(stores.map((store) => store.drainReplies()));
          for (let pass = 0; pass < 5; pass++)
            await firstStore.processAvailable();
          await firstStore.drainReplies();
          expect(summarySources).toEqual([10, 10]);
          for (const fixture of fixtures) {
            const saved = await admin<
              { completed: string; summaries: string }[]
            >`
            SELECT (SELECT count(*)::text FROM agents.memory_summary_requests
              WHERE tenant_id=${fixture.tenant}::uuid AND state='complete') AS completed,
              (SELECT count(*)::text FROM agents.messaging_memory_summaries
              WHERE tenant_id=${fixture.tenant}::uuid) AS summaries`;
            if (scenario !== "revoked") {
              expect(Number(saved[0]?.completed)).toBe(1);
              expect(Number(saved[0]?.summaries)).toBe(1);
            } else {
              expect(Number(saved[0]?.completed)).toBe(
                Number(saved[0]?.summaries),
              );
            }
          }
          const totals = await admin<{ complete: string; retry: string }[]>`
          SELECT (SELECT count(*)::text FROM agents.memory_summary_requests
            WHERE tenant_id=ANY(${fixtures.map((fixture) => fixture.tenant)}::uuid[]) AND state='complete') AS complete,
            (SELECT count(*)::text FROM ops.jobs WHERE tenant_id=ANY(${fixtures.map((fixture) => fixture.tenant)}::uuid[])
              AND job_type='memory.summary' AND status='retry') AS retry`;
          expect(Number(totals[0]?.complete)).toBe(
            scenario !== "revoked" ? 2 : 1,
          );
          expect(Number(totals[0]?.retry)).toBe(scenario !== "revoked" ? 0 : 1);
          if (scenario === "revoked") {
            await admin`UPDATE ops.jobs SET max_attempts=attempts+1,available_at=clock_timestamp()
            WHERE tenant_id=ANY(${fixtures.map((fixture) => fixture.tenant)}::uuid[])
              AND job_type='memory.summary' AND status='retry'`;
            await firstStore.processAvailable();
            await firstStore.drainReplies();
            const alerts = await admin<{ count: string }[]>`
            SELECT count(*)::text AS count FROM agents.memory_summary_alerts
              WHERE tenant_id=ANY(${fixtures.map((fixture) => fixture.tenant)}::uuid[])`;
            expect(Number(alerts[0]?.count)).toBe(1);
            expect(summarySources).toEqual([10, 10]);
          }
          if (scenario === "boundBackground") {
            expect(physicalSummaryRequests).toBe(2);
            const attempts = await admin<
              { state: string; input_tokens: number; output_tokens: number }[]
            >`
            SELECT state,input_tokens,output_tokens FROM agents.memory_summary_attempts
            WHERE tenant_id=ANY(${fixtures.map((fixture) => fixture.tenant)}::uuid[]) ORDER BY created_at`;
            expect(attempts).toHaveLength(2);
            expect(
              attempts.every(
                (attempt) =>
                  attempt.state === "complete" &&
                  attempt.input_tokens === 30 &&
                  attempt.output_tokens === 8,
              ),
            ).toBe(true);
            const counters = await admin<{ reserved_attempts: string }[]>`
            SELECT reserved_attempts FROM agents.model_daily_reservations
            WHERE tenant_id=ANY(${fixtures.map((fixture) => fixture.tenant)}::uuid[])`;
            expect(counters).toHaveLength(2);
            expect(
              counters.every(
                (counter) => Number(counter.reserved_attempts) === 1,
              ),
            ).toBe(true);
          }
          if (scenario === "positive") {
            for (const fixture of fixtures) {
              await admin.begin(async (tx) => {
                await tx`SELECT set_config('app.current_tenant',${fixture.tenant},true)`;
                for (let index = 0; index < 10; index++)
                  await tx`INSERT INTO messaging.messages(tenant_id,conversation_id,direction,sender_type,content_type,content_text,status)
                  VALUES(${fixture.tenant}::uuid,${fixture.conversation}::uuid,'inbound','contact','text',${`Fictional later customer ${String(index)}`},'received')`;
                await tx`UPDATE agents.messaging_memory_sessions SET last_activity_at=clock_timestamp()
                WHERE tenant_id=${fixture.tenant}::uuid AND conversation_id=${fixture.conversation}::uuid`;
              });
            }
            for (let pass = 0; pass < 5; pass++)
              await firstStore.processAvailable();
            expect(summarySources).toEqual([10, 10, 20, 20]);
            for (const fixture of fixtures) {
              await admin`UPDATE messaging.conversations SET ownership_mode='human',
              ai_enabled_by_user_id=NULL,ownership_epoch=ownership_epoch+1
              WHERE id=${fixture.conversation}::uuid`;
            }
            for (let pass = 0; pass < 5; pass++)
              await firstStore.processAvailable();
            expect(summarySources).toEqual([10, 10, 20, 20, 20, 20]);
            const owner = await admin<{ mode: string; summaries: string }[]>`
            SELECT c.ownership_mode AS mode,(SELECT count(*)::text FROM agents.messaging_memory_summaries summary
              WHERE summary.tenant_id=c.tenant_id) AS summaries FROM messaging.conversations c
              WHERE c.id=ANY(${fixtures.map((fixture) => fixture.conversation)}::uuid[])`;
            expect(
              owner.every(
                (row) => row.mode === "human" && Number(row.summaries) === 3,
              ),
            ).toBe(true);
          }
        } finally {
          releaseSlow();
          releaseSummary();
          try {
            await Promise.all(stores.map((store) => store.close()));
            await admin.end();
          } finally {
            await fixtureDatabase.close();
          }
        }
      },
      30000,
    );
  },
);
