import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { dashboardMetrics } from "./analytics.js";
import {
  createAutomationDraft,
  listAutomations,
  publishAutomation,
} from "./automations.js";
import {
  createSimulatorBroadcast,
  deliverSimulatorBroadcast,
  listBroadcasts,
} from "./campaigns.js";
import {
  createAgentProfileDraft,
  createCanonicalFlowDraft,
  listContactActivity,
  listVoiceOutcomes,
  publishAgentProfile,
  publishCanonicalFlow,
  queueCallOutcomeWhatsAppFollowup,
  queueWhatsAppTriggeredCall,
  requestHandoff,
  summarizeCrossChannelUsage,
  transitionHandoff,
  type CanonicalFlow,
} from "./cross-channel.js";
import {
  addContactNote,
  getContactDetail,
  importContacts,
  listContacts,
  updateContact,
} from "./contacts.js";
import {
  ingestSimulatedInbound,
  ingestWhatsAppInbound,
  listConversations,
  listMessages,
  sendSimulatedReply,
} from "./messaging.js";
import { listPipelineBoards } from "./pipelines.js";
import {
  queueWhatsAppOutbound,
  setWhatsAppConsent,
} from "./whatsapp-outbound.js";

const databaseUrl = process.env.CRM_TEST_DATABASE_URL;
const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";

class ExpectedRollback extends Error {}

describe.skipIf(databaseUrl === undefined)(
  "canonical CRM PostgreSQL adapter",
  () => {
    it("reads the seeded tenant and processes an idempotent simulator exchange", async () => {
      if (databaseUrl === undefined)
        throw new Error("CRM_TEST_DATABASE_URL is required");
      const sql = postgres(databaseUrl, { max: 1, prepare: false });
      try {
        let rolledBack = false;
        try {
          await sql.begin(async (transaction) => {
            await transaction`
            SELECT set_config('app.current_tenant', ${tenantId}, true),
                   set_config('app.current_user', ${userId}, true),
                   set_config('app.current_role', 'owner', true)
          `;
            const seededTenant = await transaction<
              { id: string; name: string }[]
            >`
              SELECT id, name FROM tenants WHERE id = ${tenantId}::uuid
            `;
            expect(seededTenant).toHaveLength(1);
            expect(seededTenant[0]?.name.trim()).not.toBe("");

            const pipelineId = randomUUID();
            await transaction`
              INSERT INTO crm.pipelines(id, tenant_id, name, is_default)
              VALUES(
                ${pipelineId}::uuid,
                ${tenantId}::uuid,
                ${`Fictional integration pipeline ${pipelineId}`},
                false
              )
            `;
            await transaction`
              INSERT INTO crm.pipeline_stages(
                tenant_id, pipeline_id, name, position, probability
              ) VALUES
                (${tenantId}::uuid, ${pipelineId}::uuid, 'New', 0, 10),
                (${tenantId}::uuid, ${pipelineId}::uuid, 'Review', 1, 50),
                (${tenantId}::uuid, ${pipelineId}::uuid, 'Complete', 2, 100)
            `;
            const imported = await importContacts(transaction, userId, [
              {
                name: "Fictional Imported Contact",
                phone: "+972509999993",
                email: "imported@example.invalid",
              },
              {
                name: "Fictional Duplicate Contact",
                phone: "+972509999993",
              },
            ]);
            expect(imported).toMatchObject({
              created: 1,
              skipped: 1,
              errors: [],
            });
            const importedContact = (
              await listContacts(transaction, { query: "Fictional Imported" })
            )[0];
            expect(importedContact).toBeDefined();
            if (importedContact === undefined)
              throw new Error("imported contact could not be found");
            await updateContact(transaction, importedContact.id, {
              company: "Updated Fictional Company",
            });
            await addContactNote(
              transaction,
              importedContact.id,
              userId,
              "Fictional integration note",
            );
            expect(
              await getContactDetail(transaction, importedContact.id),
            ).toMatchObject({
              company: "Updated Fictional Company",
              notes: [{ body: "Fictional integration note" }],
            });
            expect(
              (await listPipelineBoards(transaction)).find(
                (pipeline) => pipeline.id === pipelineId,
              )?.stages,
            ).toHaveLength(3);

            const broadcastId = await createSimulatorBroadcast(
              transaction,
              userId,
              "Fictional integration campaign",
              "A simulator-only campaign message",
            );
            expect(
              await deliverSimulatorBroadcast(transaction, broadcastId),
            ).toBeGreaterThan(0);
            expect((await listBroadcasts(transaction))[0]).toMatchObject({
              id: broadcastId,
              status: "sent",
            });

            const automationId = await createAutomationDraft(
              transaction,
              userId,
              "Fictional integration automation",
            );
            expect(await publishAutomation(transaction, automationId)).toBe(
              true,
            );
            expect((await listAutomations(transaction))[0]).toMatchObject({
              id: automationId,
              published: true,
            });

            const inbound = {
              providerEventId: "phase4-integration-event",
              providerMessageId: "phase4-integration-message",
              from: "+972509999991",
              profileName: "Fictional Integration Contact",
              text: "PostgreSQL simulator integration check",
            };
            const inserted = await ingestSimulatedInbound(
              transaction,
              userId,
              inbound,
            );
            expect(inserted.inserted).toBe(true);
            const duplicate = await ingestSimulatedInbound(
              transaction,
              userId,
              inbound,
            );
            expect(duplicate).toEqual({
              conversationId: inserted.conversationId,
              inserted: false,
            });
            const simulatorOutbound = await queueWhatsAppOutbound(transaction, {
              conversationId: inserted.conversationId,
              senderUserId: userId,
              provider: "simulator",
              kind: "text",
              text: "Durably queued simulator response",
              explicitlyConfirmed: false,
              realProviderEnabled: false,
              idempotencyKey: "phase6-simulator-outbound",
            });
            expect(simulatorOutbound).toMatchObject({
              provider: "simulator",
              queued: true,
            });
            expect(
              await transaction<{ unread_count: number }[]>`
                SELECT unread_count FROM messaging.conversations
                WHERE id = ${inserted.conversationId}::uuid
              `,
            ).toEqual([{ unread_count: 0 }]);
            expect(
              await queueWhatsAppOutbound(transaction, {
                conversationId: inserted.conversationId,
                senderUserId: userId,
                provider: "simulator",
                kind: "text",
                text: "Durably queued simulator response",
                explicitlyConfirmed: false,
                realProviderEnabled: false,
                idempotencyKey: "phase6-simulator-outbound",
              }),
            ).toMatchObject({
              requestId: simulatorOutbound.requestId,
              queued: false,
            });
            await expect(
              queueWhatsAppOutbound(transaction, {
                conversationId: inserted.conversationId,
                senderUserId: userId,
                provider: "meta",
                kind: "text",
                text: "Must not escape",
                explicitlyConfirmed: true,
                realProviderEnabled: false,
                idempotencyKey: "phase6-disabled-real-outbound",
              }),
            ).rejects.toThrow("provider is disabled");

            const metaPhoneNumberId = `fictional-${randomUUID()}`;
            const metaWabaId = `fictional-${randomUUID()}`;
            const metaGraphApiVersion = "v26.0";
            await transaction`
              INSERT INTO messaging.channels(
                tenant_id, kind, provider, provider_account_id,
                display_address, status, configuration
              ) VALUES(
                ${tenantId}::uuid,
                'whatsapp',
                'meta',
                ${metaPhoneNumberId},
                'Fictional Meta opt-out fixture',
                'active',
                ${transaction.json({
                  phoneNumberId: metaPhoneNumberId,
                  wabaId: metaWabaId,
                  graphApiVersion: metaGraphApiVersion,
                })}
              )
            `;
            const metaInbound = await ingestWhatsAppInbound(transaction, {
              providerAccountId: metaPhoneNumberId,
              providerEventId: `fictional-event-${randomUUID()}`,
              providerMessageId: `fictional-message-${randomUUID()}`,
              from: "+12025550198",
              profileName: "Fictional opted-out contact",
              text: "Fictional inbound message for opt-out validation",
              occurredAt: new Date().toISOString(),
            });
            expect(
              await setWhatsAppConsent(
                transaction,
                metaInbound.contactId,
                "revoked",
              ),
            ).toBe(true);
            await expect(
              queueWhatsAppOutbound(
                transaction,
                {
                  conversationId: metaInbound.conversationId,
                  senderUserId: userId,
                  provider: "meta",
                  kind: "template",
                  templateName: "approved_fixture",
                  language: "he",
                  parameters: [],
                  explicitlyConfirmed: true,
                  realProviderEnabled: true,
                  idempotencyKey: "phase6-opted-out-real-outbound",
                },
                {
                  graphApiVersion: metaGraphApiVersion,
                  phoneNumberId: metaPhoneNumberId,
                  wabaId: metaWabaId,
                },
              ),
            ).rejects.toThrow("opted out");
            await expect(
              queueWhatsAppTriggeredCall(
                transaction,
                userId,
                inserted.conversationId,
                "phase6-denied-call",
              ),
            ).rejects.toThrow("voice consent is required");
            await transaction`
              UPDATE crm.contacts SET voice_consent = 'granted'
              WHERE id = (SELECT contact_id FROM messaging.conversations
                            WHERE id = ${inserted.conversationId}::uuid)
            `;

            const replyInput = {
              conversationId: inserted.conversationId,
              senderUserId: userId,
              text: "Simulator reply",
              idempotencyKey: "phase4-integration-reply",
            };
            const firstReply = await sendSimulatedReply(
              transaction,
              replyInput,
            );
            const duplicateReply = await sendSimulatedReply(
              transaction,
              replyInput,
            );
            expect(duplicateReply.id).toBe(firstReply.id);
            expect(
              await listMessages(transaction, inserted.conversationId),
            ).toHaveLength(3);
            expect((await listConversations(transaction))[0]).toBeDefined();
            const agentId = await createAgentProfileDraft(transaction, userId, {
              name: "Fictional cross-channel agent",
              systemPrompt: "Operate only through approved simulator paths.",
              channels: ["voice", "whatsapp"],
            });
            expect(
              await publishAgentProfile(transaction, userId, agentId),
            ).toBe(true);
            const profileVersion = await transaction<{ id: string }[]>`
              SELECT id FROM agents.agent_profile_versions
              WHERE agent_profile_id = ${agentId}::uuid
            `;
            const profileVersionId = profileVersion[0]?.id;
            if (profileVersionId === undefined)
              throw new Error("agent version was not created");
            const flow: CanonicalFlow = {
              schemaVersion: "1.0",
              channels: ["voice", "whatsapp"],
              nodes: [
                { id: "start", type: "start" },
                { id: "voice", type: "voice.call" },
                { id: "message", type: "message.send" },
                { id: "handoff", type: "handoff" },
                { id: "end", type: "end" },
              ],
              edges: [
                { id: "voice", source: "start", target: "voice" },
                { id: "message", source: "start", target: "message" },
                { id: "voice-handoff", source: "voice", target: "handoff" },
                {
                  id: "message-handoff",
                  source: "message",
                  target: "handoff",
                },
                { id: "end", source: "handoff", target: "end" },
              ],
            };
            const flowId = await createCanonicalFlowDraft(
              transaction,
              userId,
              "Fictional cross-channel flow",
              profileVersionId,
              flow,
            );
            expect(
              await publishCanonicalFlow(transaction, userId, flowId),
            ).toBe(true);

            const voiceSessionId = randomUUID();
            await transaction`
              INSERT INTO public.sessions(
                session_id, tenant_id, contact_id, provider, direction, room,
                status, outcome, flow_id
              ) VALUES(
                ${voiceSessionId}::uuid,
                ${tenantId}::uuid,
                ${importedContact.id}::uuid,
                'simulator',
                'outbound',
                ${`crm-integration-${voiceSessionId}`},
                'ended',
                'simulator_completed',
                ${randomUUID()}::uuid
              )
            `;
            const voiceOutcome = (await listVoiceOutcomes(transaction)).find(
              (outcome) => outcome.sessionId === voiceSessionId,
            );
            if (voiceOutcome === undefined)
              throw new Error("transaction-owned voice outcome is required");
            await transaction`
              UPDATE crm.contacts SET whatsapp_consent = 'granted', whatsapp_opted_out_at = NULL
              WHERE id = (SELECT contact_id FROM public.sessions
                          WHERE session_id = ${voiceOutcome.sessionId}::uuid)
            `;
            const followup = await queueCallOutcomeWhatsAppFollowup(
              transaction,
              userId,
              voiceOutcome.sessionId,
              "phase6-call-followup",
            );
            const duplicateFollowup = await queueCallOutcomeWhatsAppFollowup(
              transaction,
              userId,
              voiceOutcome.sessionId,
              "phase6-call-followup",
            );
            expect(duplicateFollowup.jobId).toBe(followup.jobId);
            expect(duplicateFollowup.queued).toBe(false);
            const call = await queueWhatsAppTriggeredCall(
              transaction,
              userId,
              inserted.conversationId,
              "phase6-whatsapp-call",
            );
            expect(call.mode).toBe("simulator");

            const requested = await requestHandoff(
              transaction,
              userId,
              importedContact.id,
              "whatsapp",
              "Fictional customer requested a person",
              "phase6-handoff",
            );
            const accepted = await transitionHandoff(
              transaction,
              requested.id,
              userId,
              "accept",
            );
            expect(accepted.status).toBe("accepted");
            expect(
              await listContactActivity(transaction, importedContact.id),
            ).not.toHaveLength(0);
            expect(
              (await summarizeCrossChannelUsage(transaction)).estimatedCostUsd,
            ).toBeNull();
            expect(
              (await dashboardMetrics(transaction)).contacts,
            ).toBeGreaterThan(1);
            throw new ExpectedRollback("roll back integration fixture");
          });
        } catch (error) {
          if (!(error instanceof ExpectedRollback)) throw error;
          rolledBack = true;
        }
        expect(rolledBack).toBe(true);
      } finally {
        await sql.end({ timeout: 2 });
      }
    });
  },
);
