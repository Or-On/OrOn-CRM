import { setConversationOwnership } from "@or-on/crm";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createMessagingStore } from "../src/database.js";
import { SimulatorWhatsAppProvider } from "../src/providers.js";
import { seedOpeningMenuFixture } from "./opening-menu-fixture.js";

const url = process.env.OPENING_MENU_TEST_DATABASE_URL;

describe.skipIf(!url)(
  "opening menu after continuing, resuming or reopening",
  () => {
    it.each([
      "same-session",
      "human-resume",
      "archive-reopen",
      "legacy-resume",
    ])(
      "%s keeps paired menu/AI jobs responsive without reusing an old choice",
      async (scenario) => {
        const target = new URL(url ?? "");
        if (
          target.hostname !== "127.0.0.1" ||
          target.port !== "55480" ||
          !/^\/oron_crm_[a-f0-9]{32}$/.test(target.pathname)
        )
          throw new Error("Owned loopback fixture only");
        const admin = postgres(url ?? "", { max: 2, prepare: false });
        const cfg = await seedOpeningMenuFixture(admin);
        const contact = randomUUID(),
          conversation = randomUUID();
        const sender = `+1555${Date.now().toString().slice(-7)}`;
        const [channel] = await admin<{ provider_account_id: string }[]>`
        SELECT provider_account_id FROM messaging.channels WHERE id=${cfg.channel_id}::uuid`;
        const [member] = await admin<{ user_id: string }[]>`
        SELECT user_id FROM public.memberships WHERE tenant_id=${cfg.tenant_id}::uuid AND role='owner'`;
        if (!channel || !member) throw new Error("Owned binding missing");
        const account = channel.provider_account_id;
        let modelCalls = 0;
        const sends: { kind: string; id: string }[] = [];
        target.searchParams.set("options", "-c role=platform_messaging");
        const store = createMessagingStore(
          target.toString(),
          `resume-${conversation}`,
          {
            simulator: new SimulatorWhatsAppProvider(),
            meta: {
              name: "meta",
              verifyTemplate: () => Promise.resolve(true),
              send: async (request) => {
                await request.beforeAttempt?.();
                request.onAttemptStarted?.();
                const id = `synthetic-resume-${randomUUID()}`;
                sends.push({ kind: request.delivery.kind, id });
                return { messageId: id };
              },
            },
          },
          undefined,
          {
            realWhatsAppEnabled: true,
            aiProvider: {
              decide: () => {
                modelCalls++;
                return Promise.resolve({
                  action: "reply" as const,
                  text: "Which device needs help?",
                });
              },
            },
          },
        );
        async function drain() {
          for (let pass = 0; pass < 12; pass++) {
            await store.processAvailable();
            await store.drainReplies();
          }
        }
        async function inbound(
          text: string,
          choice?: { generation: string; receipt: string },
        ) {
          const message = randomUUID();
          await admin`SELECT ops.accept_whatsapp_inbound(${account},${message},${choice ? "whatsapp.message.interactive" : "whatsapp.message.text"},${admin.json(
            {
              providerAccountId: account,
              providerEventId: message,
              providerMessageId: message,
              from: sender,
              profileName: "Fictional resume",
              text,
              contentType: choice ? "interactive" : "text",
              ...(choice
                ? {
                    interaction: {
                      id: `oron.menu.${choice.generation}.support`,
                      title: "Support",
                    },
                    replyToProviderMessageId: choice.receipt,
                  }
                : {}),
              occurredAt: new Date().toISOString(),
            },
          )})`;
          await drain();
          const events = await admin<
            { status: string; last_error_safe: string | null }[]
          >`
            SELECT status,last_error_safe FROM ops.inbound_events
            WHERE tenant_id=${cfg.tenant_id}::uuid AND provider_event_id=${message}`;
          expect(events, "Canonical inbound must be ingested").toEqual([
            { status: "processed", last_error_safe: null },
          ]);
        }
        async function menu() {
          const jobs =
            await admin`SELECT job_type,status,last_error_safe FROM ops.jobs WHERE tenant_id=${cfg.tenant_id}::uuid`;
          const [state] = await admin<
            {
              generation: string;
              provider_message_id: string;
              status: string;
            }[]
          >`
          SELECT generation,provider_message_id,status FROM platform.whatsapp_opening_menu_state
          WHERE tenant_id=${cfg.tenant_id}::uuid AND conversation_id=${conversation}::uuid`;
          expect(state?.status, JSON.stringify(jobs)).toBe("sent");
          if (!state?.generation || !state.provider_message_id)
            throw new Error("Menu receipt missing");
          return {
            generation: state.generation,
            receipt: state.provider_message_id,
          };
        }
        async function legacyAllowed() {
          return admin.begin(async (tx) => {
            await tx`SELECT set_config('app.current_tenant',${cfg.tenant_id},true)`;
            const [row] = await tx<
              { allowed: boolean }[]
            >`SELECT platform.opening_menu_legacy_session(${conversation}::uuid) AS allowed`;
            return row?.allowed;
          });
        }
        try {
          await admin.begin(async (tx) => {
            await tx`SELECT set_config('app.current_tenant',${cfg.tenant_id},true)`;
            await tx`UPDATE platform.tenant_configuration_releases
              SET configuration=jsonb_set(configuration,'{features}',${tx.json(["agents", "contacts", "whatsapp", "leads", "tickets", "field_service"])})
              WHERE tenant_id=${cfg.tenant_id}::uuid AND status='published'`;
            await tx`INSERT INTO platform.tenant_feature_entitlements(tenant_id,feature_key,available,enabled,granted_at)
              VALUES(${cfg.tenant_id}::uuid,'field_service',true,true,clock_timestamp())
              ON CONFLICT(tenant_id,feature_key) DO UPDATE SET available=true,enabled=true`;
            await tx`INSERT INTO service.tenant_configuration(tenant_id,enabled,whatsapp_intake_enabled)
              VALUES(${cfg.tenant_id}::uuid,true,true)
              ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,whatsapp_intake_enabled=true`;
            if (scenario === "legacy-resume")
              await tx`UPDATE platform.whatsapp_opening_menu_configuration SET enabled=false WHERE tenant_id=${cfg.tenant_id}::uuid`;
            await tx`INSERT INTO crm.contacts(id,tenant_id,name,created_by_user_id,whatsapp_consent)
            VALUES(${contact}::uuid,${cfg.tenant_id}::uuid,'Fictional resume',${member.user_id}::uuid,'granted')`;
            await tx`INSERT INTO crm.contact_channel_identities(tenant_id,contact_id,channel,normalized_value,display_value,validation_status,is_primary)
            VALUES(${cfg.tenant_id}::uuid,${contact}::uuid,'whatsapp',${sender},${sender},'valid',true)`;
            await tx`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,status,ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at)
            VALUES(${conversation}::uuid,${cfg.tenant_id}::uuid,${cfg.channel_id}::uuid,${contact}::uuid,'open','ai',${cfg.agent_version_id}::uuid,${member.user_id}::uuid,clock_timestamp())`;
          });
          await inbound("I need help with a television");
          let oldMenu: { generation: string; receipt: string } | undefined;
          if (scenario === "legacy-resume") {
            expect(modelCalls).toBe(1);
            await admin.begin(async (tx) => {
              await tx`SELECT set_config('app.current_tenant',${cfg.tenant_id},true)`;
              await tx`UPDATE platform.whatsapp_opening_menu_configuration SET enabled=true WHERE tenant_id=${cfg.tenant_id}::uuid`;
            });
            expect(await legacyAllowed()).toBe(true);
            // More than one real worker turn must survive menu activation.
            await inbound("The screen flickers");
            await inbound("It still flickers after restarting");
            expect(modelCalls).toBe(3);
            expect(await legacyAllowed()).toBe(true);
          } else {
            expect(modelCalls).toBe(0);
            oldMenu = await menu();
            await inbound("Support", oldMenu);
            expect(modelCalls).toBe(1);
          }
          const beforeCalls = modelCalls;
          const beforeMenus = sends.filter(
            (send) => send.kind === "template",
          ).length;
          if (scenario === "same-session") {
            await inbound("The screen flickers");
            await inbound("Can you help me troubleshoot?");
            expect(modelCalls).toBe(beforeCalls + 2);
            expect(
              sends.filter((send) => send.kind === "template"),
            ).toHaveLength(beforeMenus);
            return;
          }
          await admin.begin(async (tx) => {
            await tx`SELECT set_config('app.current_tenant',${cfg.tenant_id},true),set_config('app.current_user',${member.user_id},true),set_config('app.current_role','owner',true)`;
            if (scenario === "archive-reopen") {
              await tx`UPDATE messaging.conversations SET removed_from_inbox_at=clock_timestamp(),removed_from_inbox_by_user_id=${member.user_id}::uuid WHERE id=${conversation}::uuid`;
            } else {
              expect(
                await setConversationOwnership(
                  tx,
                  conversation,
                  member.user_id,
                  "human",
                ),
              ).toBe(true);
              expect(
                await setConversationOwnership(
                  tx,
                  conversation,
                  member.user_id,
                  "ai",
                  cfg.agent_version_id,
                ),
              ).toBe(true);
            }
          });
          if (scenario === "legacy-resume")
            expect(await legacyAllowed()).toBe(false);
          await inbound("Can you help with the screen?");
          const freshMenu = await menu();
          expect(freshMenu.generation).not.toBe(oldMenu?.generation);
          expect(modelCalls).toBe(beforeCalls);
          expect(sends.filter((send) => send.kind === "template")).toHaveLength(
            beforeMenus + 1,
          );
          await inbound("Are you there?");
          if (oldMenu) await inbound("Support", oldMenu);
          expect(modelCalls).toBe(beforeCalls);
          expect(sends.filter((send) => send.kind === "template")).toHaveLength(
            beforeMenus + 1,
          );
          await inbound("Support", freshMenu);
          expect(modelCalls).toBe(beforeCalls + 1);
          await inbound("The television is still flickering");
          expect(modelCalls).toBe(beforeCalls + 2);
          const jobs = await admin<
            { status: string; last_error_safe: string | null }[]
          >`
          SELECT status,last_error_safe FROM ops.jobs WHERE tenant_id=${cfg.tenant_id}::uuid
            AND reference_id=${conversation}::uuid AND job_type IN ('whatsapp.opening_menu','whatsapp.ai.reply')`;
          expect(jobs.some((job) => job.status === "dead")).toBe(false);
          expect(
            jobs.some((job) =>
              job.last_error_safe?.includes(
                "existing_conversation_awaits_opening_boundary",
              ),
            ),
          ).toBe(false);
          const replies = await admin<{ status: string }[]>`
          SELECT status FROM messaging.messages WHERE tenant_id=${cfg.tenant_id}::uuid
            AND conversation_id=${conversation}::uuid AND direction='outbound' AND sender_type='agent'`;
          expect(replies).toHaveLength(modelCalls);
          expect(replies.every((reply) => reply.status === "sent")).toBe(true);
        } finally {
          await store.close();
          await admin.end({ timeout: 1 });
        }
      },
      60000,
    );
  },
);
