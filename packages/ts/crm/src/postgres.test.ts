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
  addContactNote,
  getContactDetail,
  importContacts,
  listContacts,
  updateContact,
} from "./contacts.js";
import {
  ingestSimulatedInbound,
  listConversations,
  listMessages,
  sendSimulatedReply,
} from "./messaging.js";
import { listPipelineBoards } from "./pipelines.js";

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
        await expect(
          sql.begin(async (transaction) => {
            await transaction`
            SELECT set_config('app.current_tenant', ${tenantId}, true),
                   set_config('app.current_user', ${userId}, true),
                   set_config('app.current_role', 'owner', true)
          `;
            const contacts = await listContacts(transaction);
            expect(
              contacts.some((contact) => contact.name === "Maya Cohen"),
            ).toBe(true);
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
              (await listPipelineBoards(transaction))[0]?.stages,
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
            ).toHaveLength(2);
            expect((await listConversations(transaction))[0]).toBeDefined();
            expect(
              (await dashboardMetrics(transaction)).contacts,
            ).toBeGreaterThan(1);
            throw new ExpectedRollback("roll back integration fixture");
          }),
        ).rejects.toBeInstanceOf(ExpectedRollback);
      } finally {
        await sql.end({ timeout: 2 });
      }
    });
  },
);
