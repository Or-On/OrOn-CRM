import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, it, expect } from "vitest";
import { createAgentProfileDraft } from "@or-on/crm";
import { createMessagingStore } from "../src/database.js";
import { SimulatorWhatsAppProvider } from "../src/providers.js";
import {
  sealModelCredential,
  createModelCredentialResolver,
} from "../src/model-credentials.js";
const url = process.env.FAIR_TEST_DATABASE_URL;
describe.skipIf(!url)(
  "actual voice producer and production-bound shadow summary consumer",
  () => {
    it.each(["positive", "revoked"] as const)(
      "10-turn and end checkpoints %s",
      async (scenario) => {
        if (!url) throw new TypeError("Owned fair fixture required");
        const target = new URL(url);
        if (
          target.hostname !== "127.0.0.1" ||
          target.port !== "55480" ||
          !/^\/oron_fair_[a-f0-9]{32}$/u.test(target.pathname)
        )
          throw new TypeError("Owned loopback fixture only");
        const admin = postgres(url, { max: 2, prepare: false });
        const tenant = randomUUID(),
          user = randomUUID(),
          contact = randomUUID(),
          session = randomUUID(),
          model = randomUUID(),
          credential = randomUUID();
        const key = Buffer.alloc(32, 27);
        const sealed = sealModelCredential(
          {
            tenantId: tenant,
            modelConfigurationId: model,
            credentialId: credential,
            provider: "openai",
          },
          "synthetic-voice-summary-token",
          key,
          "synthetic-voice:v2",
        );
        let requests = 0;
        const sources: number[] = [];
        const workerUrl = new URL(url);
        workerUrl.searchParams.set("options", "-c role=platform_messaging");
        const store = createMessagingStore(
          workerUrl.toString(),
          "synthetic-voice-summary",
          {
            simulator: new SimulatorWhatsAppProvider(),
            meta: {
              name: "meta",
              send: () =>
                Promise.reject(
                  new Error("Voice summary must not send WhatsApp"),
                ),
            },
          },
          undefined,
          {
            modelRouting: {
              resolveSealedCredential: createModelCredentialResolver(
                new Map([["synthetic-voice:v2", key]]),
              ),
              createProvider: () => ({
                decide: () =>
                  Promise.reject(new Error("AIreply port must not be used")),
              }),
            },
            memorySummaryFetch: (
              _input: RequestInfo | URL,
              init?: RequestInit,
            ) => {
              requests++;
              if (typeof init?.body !== "string")
                throw new TypeError("Missing body");
              const body = JSON.parse(init.body) as {
                tools?: unknown;
                messages: { content: string }[];
              };
              expect(body.tools).toBeUndefined();
              const content = body.messages[1]?.content;
              if (!content) throw new TypeError("Missing source");
              const turns = JSON.parse(content) as {
                source: string;
                text: string;
              }[];
              expect(
                turns.every(
                  (turn) =>
                    turn.source === "customer" &&
                    turn.text.startsWith("Synthetic unverified assertion"),
                ),
              ).toBe(true);
              sources.push(turns.length);
              return Promise.resolve(
                Response.json({
                  choices: [
                    {
                      message: {
                        content:
                          "Caller asserted an issue; identity remains unverified.",
                      },
                    },
                  ],
                  usage: { prompt_tokens: 41, completion_tokens: 9 },
                }),
              );
            },
          },
        );
        try {
          const profile = await admin.begin(async (tx) => {
            await tx`INSERT INTO public.tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Synthetic voice summary',${"voice-summary-" + tenant},'active')`;
            await tx`INSERT INTO public.users(id,email,status) VALUES(${user}::uuid,${user + "@example.invalid"},'active')`;
            await tx`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${user}::uuid,'owner')`;
            await tx`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${user},true),set_config('app.current_role','owner',true)`;
            await tx`INSERT INTO platform.tenant_feature_entitlements(tenant_id,feature_key,available,enabled,configuration,granted_at) VALUES(${tenant}::uuid,'voice',true,true,'{}',clock_timestamp()) ON CONFLICT(tenant_id,feature_key) DO UPDATE SET available=true,enabled=true`;
            await tx`INSERT INTO platform.tenant_remediation_flags(tenant_id,flag_key,enabled) VALUES(${tenant}::uuid,'session_memory',true)`;
            await tx`INSERT INTO crm.contacts(id,tenant_id,name) VALUES(${contact}::uuid,${tenant}::uuid,'Synthetic unverified caller')`;
            await tx`INSERT INTO platform.credential_records(id,tenant_id,kind,algorithm,key_version,ciphertext,nonce) VALUES(${credential}::uuid,${tenant}::uuid,${sealed.kind},${sealed.algorithm},${sealed.keyVersion},decode(${sealed.ciphertext},'hex'),decode(${sealed.nonce},'hex'))`;
            await tx`INSERT INTO agents.model_configurations(id,tenant_id,name,provider,model,credential_id,settings,daily_request_limit,is_enabled) VALUES(${model}::uuid,${tenant}::uuid,'Synthetic voice summary model','openai','synthetic-voice-model',${credential}::uuid,'{}',3,true)`;
            const profile = await createAgentProfileDraft(tx, user, {
              name: "Synthetic voice summary Agent",
              systemPrompt: "Help callers safely.",
              locale: "en",
              channels: ["voice"],
            });
            const versions = await tx<
              { id: string }[]
            >`UPDATE agents.agent_profile_versions SET model_configuration_id=${model}::uuid,published_at=clock_timestamp(),validation_status='valid' WHERE agent_profile_id=${profile}::uuid RETURNING id`;
            const version = versions[0]?.id;
            if (!version) throw new TypeError("Missing Agent");
            await tx`INSERT INTO public.sessions(session_id,tenant_id,contact_id,provider,direction,room,status,flow_id) VALUES(${session}::uuid,${tenant}::uuid,${contact}::uuid,'livekit','inbound',${"synthetic-room-" + session},'started',${randomUUID()}::uuid)`;
            await tx`INSERT INTO public.session_events(tenant_id,session_id,sequence,event_type,payload) VALUES(${tenant}::uuid,${session}::uuid,0,'voice.agent.binding.v1',${tx.json({ agent_version_id: version })})`;
            await tx`SET LOCAL ROLE platform_voice`;
            for (let ordinal = 1; ordinal <= 11; ordinal++)
              await tx`SELECT platform.append_voice_memory_turn(${session}::uuid,${ordinal},${"Synthetic unverified assertion " + String(ordinal)})`;
            await tx`RESET ROLE`;
            await tx`UPDATE public.sessions SET ended_at=clock_timestamp() WHERE session_id=${session}::uuid`;
            await tx`SET LOCAL ROLE platform_voice`;
            await tx`SELECT platform.finish_voice_memory(${session}::uuid)`;
            return profile;
          });
          const requestsBefore = await admin<
            { source_ids: string[]; privacy_scope: string }[]
          >`SELECT source_ids,privacy_scope FROM agents.memory_summary_requests WHERE tenant_id=${tenant}::uuid ORDER BY created_at`;
          expect(
            requestsBefore.map((request) => request.source_ids.length),
          ).toEqual([10, 11]);
          expect(
            requestsBefore.every(
              (request) => request.privacy_scope === "session_only",
            ),
          ).toBe(true);
          if (scenario === "revoked")
            await admin`UPDATE agents.agent_profiles SET archived_at=clock_timestamp() WHERE id=${profile}::uuid`;
          for (let pass = 0; pass < 6; pass++) {
            await store.processAvailable();
            await store.drainReplies();
          }
          const requestsAfter = await admin<
            { state: string; privacy_scope: string }[]
          >`SELECT state,privacy_scope FROM agents.memory_summary_requests WHERE tenant_id=${tenant}::uuid`;
          expect(requests).toBe(scenario === "positive" ? 2 : 0);
          expect([...sources].sort((left, right) => left - right)).toEqual(
            scenario === "positive" ? [10, 11] : [],
          );
          expect(
            requestsAfter.every(
              (request) =>
                request.state ===
                  (scenario === "positive" ? "complete" : "pending") &&
                request.privacy_scope === "session_only",
            ),
          ).toBe(true);
          const turns = await admin<
            { identity_verified: boolean; verified_contact_id: string | null }[]
          >`SELECT identity_verified,verified_contact_id FROM agents.voice_memory_turns WHERE tenant_id=${tenant}::uuid`;
          expect(turns).toHaveLength(11);
          expect(
            turns.every(
              (turn) =>
                !turn.identity_verified && turn.verified_contact_id === null,
            ),
          ).toBe(true);
          const attempts = await admin<
            { state: string; input_tokens: number; output_tokens: number }[]
          >`SELECT state,input_tokens,output_tokens FROM agents.memory_summary_attempts WHERE tenant_id=${tenant}::uuid`;
          expect(attempts).toHaveLength(scenario === "positive" ? 2 : 0);
          expect(
            attempts.every(
              (attempt) =>
                attempt.state === "complete" &&
                attempt.input_tokens === 41 &&
                attempt.output_tokens === 9,
            ),
          ).toBe(true);
          const quota = await admin<
            { attempts: string }[]
          >`SELECT coalesce(sum(reserved_attempts),0)::text AS attempts FROM agents.model_daily_reservations WHERE tenant_id=${tenant}::uuid`;
          expect(Number(quota[0]?.attempts)).toBe(
            scenario === "positive" ? 2 : 0,
          );
          const promoted = await admin<
            { count: string }[]
          >`SELECT count(*)::text AS count FROM agents.messaging_memory_summaries WHERE tenant_id=${tenant}::uuid`;
          expect(Number(promoted[0]?.count)).toBe(0);
        } finally {
          await store.close();
          await admin.end({ timeout: 1 });
        }
      },
      30000,
    );
  },
);
