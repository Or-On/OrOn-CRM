import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { createAgentProfileDraft } from "@or-on/crm";
import { createMessagingStore } from "../src/database.js";
import {
  SimulatorWhatsAppProvider,
  type WhatsAppSendRequest,
} from "../src/providers.js";
import {
  createModelCredentialResolver,
  sealModelCredential,
} from "../src/model-credentials.js";
import { OpenAiCompatibleChatProvider } from "../src/ai-provider.js";

const url = process.env.FAIR_TEST_DATABASE_URL;
describe.skipIf(!url)("actual worker trusted model routing", () => {
  it.each([
    "configured",
    "configuredSealed",
    "configuredSealedRotated",
    "configuredDefaultQuota",
    "configuredRetry",
    "configuredQuotaExhausted",
    "disabled",
    "missingResolver",
  ] as const)(
    "explicit %s route never calls the deployment model",
    async (scenario) => {
      if (!url) throw new Error("Owned fair fixture required");
      const target = new URL(url);
      if (
        target.hostname !== "127.0.0.1" ||
        target.port !== "55480" ||
        !/^\/oron_fair_[a-f0-9]{32}$/u.test(target.pathname)
      )
        throw new Error("Independent local fair fixture only");
      const admin = postgres(url, { max: 2, prepare: false });
      const fixtures: {
        tenant: string;
        account: string;
        from: string;
        conversation: string;
      }[] = [];
      const sent: string[] = [];
      const selectedModels: string[] = [];
      let globalCalls = 0,
        quotaReservations = 0;
      const sealingKey = Buffer.alloc(32, 37);
      const resolveSealedCredential = createModelCredentialResolver(
        new Map([["env:model:v2", sealingKey]]),
      );
      let rotated = false;
      const response = () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    (scenario === "configuredRetry" ||
                      scenario === "configuredQuotaExhausted") &&
                    selectedModels.length === 1
                      ? "invalid synthetic primary output"
                      : JSON.stringify({
                          action: "reply",
                          reasonCode: null,
                          text: "Hello! How can I help?",
                        }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      const model = new OpenAiCompatibleChatProvider({
        apiKey: "synthetic-global",
        baseUrl: "https://example.invalid",
        model: "deployment-global",
      });
      vi.stubGlobal("fetch", (_: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body !== "string")
          throw new Error("Expected JSON model request");
        if (
          scenario === "configuredSealed" ||
          scenario === "configuredSealedRotated"
        )
          expect(new Headers(init.headers).get("authorization")).toBe(
            scenario === "configuredSealedRotated"
              ? "Bearer synthetic-rotated"
              : "Bearer synthetic-sealed",
          );
        const body = JSON.parse(init.body) as { model: string };
        if (body.model === "deployment-global") globalCalls++;
        else selectedModels.push(body.model);
        return Promise.resolve(response());
      });
      const workerTarget = new URL(url);
      workerTarget.searchParams.set("options", "-c role=platform_messaging");
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
            ...(scenario === "configuredSealedRotated"
              ? {
                  beforeModelAttempt: async () => {
                    if (rotated) return;
                    rotated = true;
                    const fixture = fixtures[0];
                    if (!fixture) throw new Error("Missing rotation fixture");
                    const rows = await admin<
                      { id: string; credential_id: string }[]
                    >`
                  select id,credential_id from agents.model_configurations where tenant_id=${fixture.tenant}::uuid`;
                    const row = rows[0];
                    if (!row) throw new Error("Missing rotation model");
                    const sealed = sealModelCredential(
                      {
                        tenantId: fixture.tenant,
                        modelConfigurationId: row.id,
                        credentialId: row.credential_id,
                        provider: "gemini",
                      },
                      "synthetic-rotated",
                      sealingKey,
                    );
                    await admin`update platform.credential_records set ciphertext=decode(${sealed.ciphertext},'hex'),nonce=decode(${sealed.nonce},'hex') where tenant_id=${fixture.tenant}::uuid and id=${row.credential_id}::uuid`;
                  },
                }
              : {}),
            modelRouting: {
              ...(scenario === "configuredSealed" ||
              scenario === "configuredSealedRotated"
                ? { resolveSealedCredential }
                : scenario === "missingResolver"
                  ? {}
                  : {
                      resolveCredential: () =>
                        Promise.resolve({ apiKey: "synthetic-configured" }),
                    }),
              ...(scenario === "configured"
                ? {
                    reserveDailyAttempt: () => {
                      quotaReservations++;
                      return Promise.resolve(quotaReservations <= 2);
                    },
                  }
                : {}),
              createProvider: (route) =>
                new OpenAiCompatibleChatProvider({
                  apiKey: route.credential.apiKey,
                  baseUrl: route.baseUrl,
                  model: route.model,
                  ...route.settings,
                }),
            },
          },
        ),
      );
      try {
        const firstStore = stores[0];
        const secondStore = stores[1];
        if (!firstStore || !secondStore)
          throw new Error("Two worker stores required");
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
            await tx`insert into platform.tenant_remediation_flags(tenant_id,flag_key,enabled) values(${tenant}::uuid,'queue_priority',true)`;
            await tx`insert into messaging.channels(id,tenant_id,kind,provider,provider_account_id,display_address,status,configuration) values(${channel}::uuid,${tenant}::uuid,'whatsapp','meta',${account},'Synthetic account','active',${tx.json({ phoneNumberId: account, wabaId: "synthetic-waba", graphApiVersion: "v26.0" })})`;
            await tx`insert into crm.contacts(id,tenant_id,created_by_user_id,name,whatsapp_consent) values(${contact}::uuid,${tenant}::uuid,${user}::uuid,${index === 0 ? "Synthetic A" : "Synthetic B"},'granted')`;
            await tx`insert into crm.contact_channel_identities(tenant_id,contact_id,channel,normalized_value,display_value,validation_status,is_primary) values(${tenant}::uuid,${contact}::uuid,'whatsapp',${"+" + from},${"+" + from},'valid',true)`;
            const credential = randomUUID(),
              configuration = randomUUID();
            if (
              scenario === "configuredSealed" ||
              scenario === "configuredSealedRotated"
            ) {
              const sealed = sealModelCredential(
                {
                  tenantId: tenant,
                  modelConfigurationId: configuration,
                  credentialId: credential,
                  provider: "gemini",
                },
                "synthetic-sealed",
                sealingKey,
              );
              await tx`insert into platform.credential_records(id,tenant_id,kind,algorithm,key_version,ciphertext,nonce) values(${credential}::uuid,${tenant}::uuid,${sealed.kind},${sealed.algorithm},${sealed.keyVersion},decode(${sealed.ciphertext},'hex'),decode(${sealed.nonce},'hex'))`;
            } else
              await tx`insert into platform.credential_records(id,tenant_id,kind) values(${credential}::uuid,${tenant}::uuid,'llm_api_key')`;
            await tx`insert into agents.model_configurations(id,tenant_id,name,provider,model,credential_id,settings,daily_request_limit,is_enabled) values(${configuration}::uuid,${tenant}::uuid,'Synthetic model','gemini','tenant-selected-model',${credential}::uuid,'{}',${scenario === "configuredQuotaExhausted" || scenario === "configuredSealedRotated" ? 1 : 2},${scenario !== "disabled"})`;
            const profile = await createAgentProfileDraft(tx, user, {
              name: "Synthetic fairness agent",
              systemPrompt: "Help customers safely.",
              locale: "en",
              channels: ["whatsapp"],
            });
            const versions = await tx<
              { id: string }[]
            >`update agents.agent_profile_versions set model_configuration_id=${configuration}::uuid,published_at=clock_timestamp(),validation_status='valid' where agent_profile_id=${profile}::uuid returning id`;
            const version = versions[0]?.id;
            if (!version) throw new Error("Synthetic agent version absent");
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
        for (let pass = 0; pass < 8; pass++) {
          await firstStore.processAvailable();
          await firstStore.drainReplies();
        }
        expect(globalCalls).toBe(0);
        if (scenario === "configured") {
          expect(selectedModels).toEqual(["tenant-selected-model"]);
          expect(quotaReservations).toBe(1);
        } else if (
          scenario === "configuredSealed" ||
          scenario === "configuredDefaultQuota" ||
          scenario === "configuredRetry" ||
          scenario === "configuredQuotaExhausted"
        ) {
          expect(selectedModels).toEqual(
            Array.from(
              { length: scenario === "configuredRetry" ? 2 : 1 },
              () => "tenant-selected-model",
            ),
          );
          expect(quotaReservations).toBe(0);
        } else {
          expect(selectedModels).toHaveLength(0);
          expect(quotaReservations).toBe(0);
        }
        const fixture = fixtures[0],
          foreign = fixtures[1];
        if (!fixture || !foreign) throw new Error("Missing routing fixtures");
        if (scenario === "configuredSealedRotated") {
          const counters =
            await admin`select reserved_attempts from agents.model_daily_reservations where tenant_id=${fixture.tenant}::uuid`;
          expect(counters).toHaveLength(0);
          // The rejected stale key must not exhaust the only daily physical attempt.
          await accept(0);
          for (let pass = 0; pass < 8; pass++) {
            await firstStore.processAvailable();
            await firstStore.drainReplies();
          }
          expect(selectedModels).toEqual(["tenant-selected-model"]);
          expect(globalCalls).toBe(0);
          const after = await admin<
            { reserved_attempts: string }[]
          >`select reserved_attempts from agents.model_daily_reservations where tenant_id=${fixture.tenant}::uuid`;
          expect(after).toHaveLength(1);
          expect(Number(after[0]?.reserved_attempts)).toBe(1);
        }
        if (
          scenario === "configuredSealed" ||
          scenario === "configuredDefaultQuota" ||
          scenario === "configuredRetry" ||
          scenario === "configuredQuotaExhausted"
        ) {
          const counters = await admin<
            { reserved_attempts: string }[]
          >`select r.reserved_attempts from agents.model_daily_reservations r join agents.agent_profile_versions a on a.tenant_id=r.tenant_id and a.model_configuration_id=r.model_configuration_id join messaging.conversations c on c.tenant_id=a.tenant_id and c.ai_agent_profile_version_id=a.id where c.id=${fixture.conversation}::uuid`;
          expect(counters).toHaveLength(1);
          expect(Number(counters[0]?.reserved_attempts)).toBe(
            scenario === "configuredRetry" ? 2 : 1,
          );
        }
        const foreignBindings = await admin<
          { version: string; actor: string; channel: string }[]
        >`select ai_agent_profile_version_id version,ai_enabled_by_user_id actor,channel_id channel from messaging.conversations where id=${foreign.conversation}::uuid`;
        const foreignBinding = foreignBindings[0];
        if (!foreignBinding) throw new Error("Missing foreign binding");
        await admin.begin(async (tx) => {
          await tx`set local role platform_messaging`;
          await tx`select set_config('app.current_tenant',${fixture.tenant},true)`;
          const rows = await tx<
            { route: unknown }[]
          >`select platform.current_published_model_route(c.ai_agent_profile_version_id,c.ai_enabled_by_user_id,c.channel_id) route from messaging.conversations c where c.tenant_id=${foreign.tenant}::uuid`;
          expect(rows).toHaveLength(0);
          const denied = await tx<
            { route: unknown }[]
          >`select platform.current_published_model_route(${foreignBinding.version}::uuid,${foreignBinding.actor}::uuid,${foreignBinding.channel}::uuid) route`;
          expect(denied[0]?.route).toBeNull();
        });
      } finally {
        vi.unstubAllGlobals();
        await Promise.all(stores.map((store) => store.close()));
        await admin.end();
      }
    },
    30000,
  );
});
