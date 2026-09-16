import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  deleteConversation,
  ingestSimulatedInbound,
  ingestWhatsAppInbound,
  listConversations,
  listMessagePage,
  listMessages,
} from "./messaging.js";
import {
  createAgentProfileDraft,
  publishAgentProfile,
} from "./cross-channel.js";
import { queueWhatsAppOutbound } from "./whatsapp-outbound.js";

// Fixture setup needs the owned migrator connection. The preview runner also
// exposes UI_TEST_DATABASE_URL, but that login intentionally has only the
// platform_web runtime grants and must not seed feature entitlements directly.
const databaseUrl =
  process.env.CRM_TEST_DATABASE_URL ?? process.env.UI_TEST_DATABASE_URL;
const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";

class ExpectedRollback extends Error {}

async function isolated(
  work: (transaction: postgres.TransactionSql) => Promise<void>,
) {
  if (databaseUrl === undefined)
    throw new Error("Use the isolated UI PostgreSQL preview test runner");
  const target = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    !/^\/oron_ui_preview_[a-f0-9]+$/.test(target.pathname)
  )
    throw new Error("Only owned fictional databases are permitted");
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    try {
      await sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO platform.tenant_feature_entitlements(
            tenant_id,feature_key,available,granted_by_user_id,granted_at
          ) VALUES(
            ${tenantId}::uuid,'field_service',true,${userId}::uuid,CURRENT_TIMESTAMP
          ) ON CONFLICT (tenant_id,feature_key) DO UPDATE SET available=true
        `;
        await transaction`
          INSERT INTO service.tenant_configuration(tenant_id,enabled)
          VALUES(${tenantId}::uuid,true)
          ON CONFLICT (tenant_id) DO UPDATE SET enabled=true
        `;
        await transaction`SET LOCAL ROLE platform_web`;
        await transaction`
          SELECT set_config('app.current_tenant', ${tenantId}, true),
                 set_config('app.current_user', ${userId}, true),
                 set_config('app.current_role', 'owner', true)
        `;
        await work(transaction);
        throw new ExpectedRollback("roll back conversation deletion fixtures");
      });
    } catch (error) {
      if (!(error instanceof ExpectedRollback)) throw error;
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function fixture(transaction: postgres.TransactionSql) {
  const suffix = randomUUID();
  const recipientAddress = `+1202${suffix.replace(/\D/gu, "").padEnd(7, "0").slice(0, 7)}`;
  const contacts = await transaction<{ id: string }[]>`
    INSERT INTO crm.contacts (tenant_id, created_by_user_id, name)
    VALUES (platform.current_tenant_id(), ${userId}::uuid,
            ${`Fictional deletion ${suffix}`})
    RETURNING id
  `;
  const channels = await transaction<{ id: string }[]>`
    INSERT INTO messaging.channels
      (tenant_id, kind, provider, display_address, provider_account_id, status)
    VALUES (platform.current_tenant_id(), 'whatsapp', 'simulator',
            ${`Fictional deletion ${suffix}`}, ${`delete-${suffix}`}, 'active')
    RETURNING id
  `;
  const contactId = contacts[0]?.id;
  const channelId = channels[0]?.id;
  if (contactId === undefined || channelId === undefined)
    throw new Error("conversation deletion fixture could not be created");
  await transaction`
    INSERT INTO crm.contact_channel_identities(
      tenant_id,contact_id,channel,normalized_value,display_value,provider,
      provider_identity_id,validation_status,is_primary
    ) VALUES(
      platform.current_tenant_id(),${contactId}::uuid,'whatsapp',
      ${recipientAddress},${recipientAddress},'simulator',${recipientAddress},
      'valid',true
    )
  `;
  const conversations = await transaction<{ id: string }[]>`
    INSERT INTO messaging.conversations
      (tenant_id, channel_id, contact_id, status)
    VALUES (platform.current_tenant_id(), ${channelId}::uuid,
            ${contactId}::uuid, 'open')
    RETURNING id
  `;
  const conversationId = conversations[0]?.id;
  if (conversationId === undefined)
    throw new Error("conversation deletion fixture could not be created");
  const messages = await transaction<{ id: string }[]>`
    INSERT INTO messaging.messages
      (tenant_id, conversation_id, direction, sender_type, content_type,
       content_text, status)
    VALUES (platform.current_tenant_id(), ${conversationId}::uuid, 'inbound',
            'contact', 'text', 'Fictional deletion content', 'received')
    RETURNING id
  `;
  const messageId = messages[0]?.id;
  if (messageId === undefined)
    throw new Error("conversation deletion message could not be created");
  return { contactId, conversationId, messageId, recipientAddress };
}

describe.skipIf(databaseUrl === undefined)(
  "tenant-safe conversation deletion",
  () => {
    it("cascades messaging data while retaining the contact and audit evidence", async () => {
      await isolated(async (transaction) => {
        const record = await fixture(transaction);
        const handoffs = await transaction<{ id: string }[]>`
          INSERT INTO automation.handoffs
            (tenant_id, contact_id, conversation_id, requested_by_user_id,
             source_channel, reason_safe, status, idempotency_key)
          VALUES (platform.current_tenant_id(), ${record.contactId}::uuid,
                  ${record.conversationId}::uuid, ${userId}::uuid,
                  'whatsapp', 'Fictional retained handoff', 'resolved',
                  ${`delete-handoff:${randomUUID()}`})
          RETURNING id
        `;
        const handoffId = handoffs[0]?.id;
        if (handoffId === undefined)
          throw new Error("retained handoff fixture could not be created");
        const storageKey = `fictional/${randomUUID()}.png`;
        const objects = await transaction<{ id: string }[]>`
          INSERT INTO objects.object_metadata(
            tenant_id,created_by_user_id,owner_type,owner_id,category,
            content_type,byte_size,checksum,storage_backend,storage_key,status
          ) VALUES(
            platform.current_tenant_id(),${userId}::uuid,'message',
            ${record.messageId}::uuid,'whatsapp_customer_image','image/png',1,
            'fictional-checksum','local',${storageKey},
            'available'
          ) RETURNING id
        `;
        const objectId = objects[0]?.id;
        if (objectId === undefined)
          throw new Error("message media object fixture could not be created");
        await transaction`
          UPDATE messaging.messages SET object_id=${objectId}::uuid
          WHERE id=${record.messageId}::uuid
        `;
        await transaction`
          INSERT INTO messaging.notifications(
            tenant_id,user_id,type,title,reference_type,reference_id
          ) VALUES(
            platform.current_tenant_id(),${userId}::uuid,'whatsapp.inbound',
            'Fictional deletion notification','conversation',
            ${record.conversationId}::uuid
          )
        `;
        expect(
          await deleteConversation(transaction, record.conversationId, userId),
        ).toEqual({
          status: "deleted",
          privateObjects: [
            {
              id: objectId,
              storageBackend: "local",
              storageKey,
            },
          ],
        });
        expect(
          await transaction`
            SELECT id FROM messaging.messages
            WHERE conversation_id = ${record.conversationId}::uuid
          `,
        ).toHaveLength(0);
        expect(
          await transaction`
            SELECT id FROM crm.contacts WHERE id = ${record.contactId}::uuid
          `,
        ).toHaveLength(1);
        expect(
          await transaction`
            SELECT id FROM audit.records
            WHERE action = 'conversation.deleted'
              AND target_id = ${record.conversationId}::uuid
          `,
        ).toHaveLength(1);
        const retained = await transaction<
          { tenantId: string; conversationId: string | null }[]
        >`
          SELECT tenant_id AS "tenantId", conversation_id AS "conversationId"
          FROM automation.handoffs WHERE id = ${handoffId}::uuid
        `;
        expect(retained).toEqual([{ tenantId, conversationId: null }]);
        const tombstone = await transaction<
          { status: string; deleted_at: Date | null }[]
        >`
          SELECT status,deleted_at FROM objects.object_metadata
          WHERE id=${objectId}::uuid
        `;
        expect(tombstone[0]?.status).toBe("deleted");
        expect(tombstone[0]?.deleted_at).toBeInstanceOf(Date);
        expect(
          await transaction`
            SELECT id FROM messaging.notifications
            WHERE reference_type='conversation'
              AND reference_id=${record.conversationId}::uuid
          `,
        ).toHaveLength(0);
      });
    });

    it("refuses deletion while durable conversation work is active", async () => {
      await isolated(async (transaction) => {
        const record = await fixture(transaction);
        await transaction`
          INSERT INTO ops.jobs
            (tenant_id, queue, job_type, reference_type, reference_id, payload,
             idempotency_key)
          VALUES (platform.current_tenant_id(), 'messaging',
                  'whatsapp.ai.reply', 'conversation',
                  ${record.conversationId}::uuid, '{}'::jsonb,
                  ${`delete-test:${randomUUID()}`})
        `;
        expect(
          await deleteConversation(transaction, record.conversationId, userId),
        ).toEqual({ status: "active_work" });
        expect(
          await transaction`
            SELECT id FROM messaging.conversations
            WHERE id = ${record.conversationId}::uuid
          `,
        ).toHaveLength(1);
      });
    });

    it("refuses deletion while a conversation handoff is unresolved", async () => {
      await isolated(async (transaction) => {
        const record = await fixture(transaction);
        await transaction`
          INSERT INTO automation.handoffs
            (tenant_id, contact_id, conversation_id, requested_by_user_id,
             source_channel, reason_safe, status, idempotency_key)
          VALUES (platform.current_tenant_id(), ${record.contactId}::uuid,
                  ${record.conversationId}::uuid, ${userId}::uuid,
                  'whatsapp', 'Fictional pending handoff', 'pending',
                  ${`delete-pending-handoff:${randomUUID()}`})
        `;

        expect(
          await deleteConversation(transaction, record.conversationId, userId),
        ).toEqual({ status: "active_work" });
        expect(
          await transaction`
            SELECT id FROM messaging.conversations
            WHERE id = ${record.conversationId}::uuid
          `,
        ).toHaveLength(1);
      });
    });

    it("refuses deletion when active work is bound only through its callback message", async () => {
      await isolated(async (transaction) => {
        const record = await fixture(transaction);
        await transaction`
          INSERT INTO ops.jobs(
            tenant_id,queue,job_type,reference_type,reference_id,payload,
            idempotency_key,callback_trigger_message_id
          ) VALUES(
            platform.current_tenant_id(),'messaging','fixture.callback.bound',
            'contact',${record.contactId}::uuid,'{}'::jsonb,
            ${`delete-callback:${randomUUID()}`},${record.messageId}::uuid
          )
        `;

        expect(
          await deleteConversation(transaction, record.conversationId, userId),
        ).toEqual({ status: "active_work" });
        expect(
          await transaction`
            SELECT id FROM messaging.messages WHERE id=${record.messageId}::uuid
          `,
        ).toHaveLength(1);
      });
    });

    it("removes retained technician evidence from the Inbox without erasing it", async () => {
      await isolated(async (transaction) => {
        const record = await fixture(transaction);
        const cases = await transaction<{ id: string }[]>`
          INSERT INTO service.cases(
            tenant_id,reference,customer_contact_id,conversation_id,title,
            fault_description,created_by_user_id
          ) VALUES(
            platform.current_tenant_id(),${`FS-${randomUUID()}`},
            ${record.contactId}::uuid,${record.conversationId}::uuid,
            'Fictional retained case','Synthetic retained evidence',
            ${userId}::uuid
          ) RETURNING id
        `;
        expect(cases).toHaveLength(1);
        const agentId = await createAgentProfileDraft(transaction, userId, {
          name: `Fictional removal agent ${randomUUID()}`,
          systemPrompt: "Synthetic prompt for retained conversation removal.",
          channels: ["whatsapp"],
        });
        expect(await publishAgentProfile(transaction, userId, agentId)).toBe(
          true,
        );
        const versions = await transaction<{ id: string }[]>`
          SELECT id FROM agents.agent_profile_versions
          WHERE agent_profile_id=${agentId}::uuid
          ORDER BY version DESC LIMIT 1
        `;
        const agentVersionId = versions[0]?.id;
        if (agentVersionId === undefined)
          throw new Error("retained conversation agent version missing");
        await transaction`
          UPDATE messaging.conversations
          SET ownership_mode='ai',
              ai_agent_profile_version_id=${agentVersionId}::uuid,
              ai_enabled_by_user_id=${userId}::uuid,
              ai_enabled_at=CURRENT_TIMESTAMP
          WHERE id=${record.conversationId}::uuid
        `;
        await transaction`
          UPDATE messaging.conversations SET unread_count=3
          WHERE id=${record.conversationId}::uuid
        `;
        await transaction`
          INSERT INTO messaging.notifications(
            tenant_id,user_id,type,title,reference_type,reference_id
          ) VALUES(
            platform.current_tenant_id(),${userId}::uuid,'whatsapp.inbound',
            'Fictional retained notification','conversation',
            ${record.conversationId}::uuid
          )
        `;

        expect(
          await deleteConversation(transaction, record.conversationId, userId),
        ).toEqual({ status: "removed_retained_evidence" });
        const retained = await transaction<
          {
            removed_at: Date | null;
            removed_by: string | null;
            unread_count: number;
            ownership_mode: string;
            agent_version_id: string | null;
            ai_enabled_by: string | null;
          }[]
        >`
          SELECT removed_from_inbox_at AS removed_at,
                 removed_from_inbox_by_user_id AS removed_by, unread_count,
                 ownership_mode,
                 ai_agent_profile_version_id AS agent_version_id,
                 ai_enabled_by_user_id AS ai_enabled_by
          FROM messaging.conversations WHERE id=${record.conversationId}::uuid
        `;
        expect(retained[0]?.removed_at).toBeInstanceOf(Date);
        expect(retained[0]?.removed_by).toBe(userId);
        expect(retained[0]?.unread_count).toBe(0);
        expect(retained[0]?.ownership_mode).toBe("human");
        expect(retained[0]?.agent_version_id).toBeNull();
        expect(retained[0]?.ai_enabled_by).toBeNull();
        expect(await listConversations(transaction)).toEqual([]);
        expect(
          await listMessagePage(transaction, record.conversationId),
        ).toEqual({ messages: [], nextCursor: null });
        expect(
          (
            await listMessages(transaction, record.conversationId, {
              includeRemoved: true,
            })
          ).map((message) => message.id),
        ).toContain(record.messageId);
        expect(
          await transaction`
            SELECT id FROM messaging.messages WHERE id=${record.messageId}::uuid
          `,
        ).toHaveLength(1);
        expect(
          await transaction`
            SELECT id FROM messaging.notifications
            WHERE reference_type='conversation'
              AND reference_id=${record.conversationId}::uuid
          `,
        ).toHaveLength(0);
        expect(
          await transaction`
            SELECT id FROM audit.records
            WHERE action='conversation.removed_from_inbox'
              AND target_id=${record.conversationId}::uuid
          `,
        ).toHaveLength(1);

        await expect(
          queueWhatsAppOutbound(transaction, {
            conversationId: record.conversationId,
            senderUserId: userId,
            provider: "simulator",
            kind: "text",
            text: "Fictional reply after Inbox removal",
            explicitlyConfirmed: false,
            realProviderEnabled: false,
            idempotencyKey: `retained-after-removal:${randomUUID()}`,
          }),
        ).rejects.toThrow("conversation is no longer available in the Inbox");
        expect(
          await transaction`
            SELECT id FROM messaging.outbound_requests
            WHERE conversation_id=${record.conversationId}::uuid
          `,
        ).toHaveLength(0);

        expect(
          await deleteConversation(transaction, record.conversationId, userId),
        ).toEqual({ status: "removed_retained_evidence" });
        expect(
          await transaction`
            SELECT id FROM audit.records
            WHERE action='conversation.removed_from_inbox'
              AND target_id=${record.conversationId}::uuid
          `,
        ).toHaveLength(1);
      });
    });

    it("reactivates a removed retained conversation only for a new inbound message", async () => {
      await isolated(async (transaction) => {
        const suffix = randomUUID().replaceAll("-", "");
        const from = `+1202${suffix.replace(/\D/gu, "").padEnd(7, "0").slice(0, 7)}`;
        const firstMessageId = `fixture-first-${suffix}`;
        const input = {
          from,
          profileName: "Fictional reactivation customer",
          text: "Fictional first request",
          providerEventId: `fixture-event-first-${suffix}`,
          providerMessageId: firstMessageId,
        };
        const first = await ingestSimulatedInbound(transaction, userId, input);
        expect(first.inserted).toBe(true);
        const contacts = await transaction<{ contact_id: string }[]>`
          SELECT contact_id FROM messaging.conversations
          WHERE id=${first.conversationId}::uuid
        `;
        const contactId = contacts[0]?.contact_id;
        if (contactId === undefined)
          throw new Error("reactivation contact missing");
        await transaction`
          INSERT INTO service.cases(
            tenant_id,reference,customer_contact_id,conversation_id,title,
            fault_description,created_by_user_id
          ) VALUES(
            platform.current_tenant_id(),${`FS-${suffix}`},${contactId}::uuid,
            ${first.conversationId}::uuid,'Fictional reactivation case',
            'Synthetic retained evidence',${userId}::uuid
          )
        `;
        expect(
          await deleteConversation(transaction, first.conversationId, userId),
        ).toEqual({ status: "removed_retained_evidence" });

        const duplicate = await ingestSimulatedInbound(transaction, userId, {
          ...input,
          providerEventId: `fixture-event-retry-${suffix}`,
        });
        expect(duplicate).toEqual({
          conversationId: first.conversationId,
          inserted: false,
        });
        expect(await listConversations(transaction)).toEqual([]);

        const fresh = await ingestSimulatedInbound(transaction, userId, {
          ...input,
          text: "Fictional genuinely new request",
          providerEventId: `fixture-event-new-${suffix}`,
          providerMessageId: `fixture-new-${suffix}`,
        });
        expect(fresh).toEqual({
          conversationId: first.conversationId,
          inserted: true,
        });
        expect(
          (await listConversations(transaction)).map((item) => item.id),
        ).toEqual([first.conversationId]);
        const restored = await transaction<
          { removed_at: Date | null; removed_by: string | null }[]
        >`
          SELECT removed_from_inbox_at AS removed_at,
                 removed_from_inbox_by_user_id AS removed_by
          FROM messaging.conversations WHERE id=${first.conversationId}::uuid
        `;
        expect(restored).toEqual([{ removed_at: null, removed_by: null }]);
      });
    });

    it("applies the same retry-safe reactivation rule to real Meta inbound messages", async () => {
      await isolated(async (transaction) => {
        const suffix = randomUUID().replaceAll("-", "");
        const providerAccountId = `fixture-phone-${suffix}`;
        await transaction`
          INSERT INTO messaging.channels(
            tenant_id,kind,provider,provider_account_id,display_address,status,
            configuration
          ) VALUES(
            platform.current_tenant_id(),'whatsapp','meta',${providerAccountId},
            'Fictional Meta reactivation channel','active',
            ${transaction.json({
              phoneNumberId: providerAccountId,
              wabaId: `fixture-waba-${suffix}`,
              graphApiVersion: "v26.0",
            })}
          )
        `;
        const firstMessageId = `fixture-meta-first-${suffix}`;
        const input = {
          providerAccountId,
          providerEventId: `fixture-meta-event-first-${suffix}`,
          providerMessageId: firstMessageId,
          from: `+1203${suffix.replace(/\D/gu, "").padEnd(7, "0").slice(0, 7)}`,
          profileName: "Fictional Meta reactivation customer",
          text: "Fictional Meta first request",
          occurredAt: new Date().toISOString(),
        };
        await transaction`SET LOCAL ROLE platform_messaging`;
        const first = await ingestWhatsAppInbound(transaction, input);
        await transaction`SET LOCAL ROLE platform_web`;
        expect(first.inserted).toBe(true);
        await transaction`
          INSERT INTO service.cases(
            tenant_id,reference,customer_contact_id,conversation_id,title,
            fault_description,created_by_user_id
          ) VALUES(
            platform.current_tenant_id(),${`FS-META-${suffix}`},
            ${first.contactId}::uuid,${first.conversationId}::uuid,
            'Fictional Meta reactivation case','Synthetic retained evidence',
            ${userId}::uuid
          )
        `;
        expect(
          await deleteConversation(transaction, first.conversationId, userId),
        ).toEqual({ status: "removed_retained_evidence" });

        await transaction`SET LOCAL ROLE platform_messaging`;
        const duplicate = await ingestWhatsAppInbound(transaction, {
          ...input,
          providerEventId: `fixture-meta-event-retry-${suffix}`,
        });
        await transaction`SET LOCAL ROLE platform_web`;
        expect(duplicate).toMatchObject({
          conversationId: first.conversationId,
          inserted: false,
        });
        expect(await listConversations(transaction)).toEqual([]);

        await transaction`SET LOCAL ROLE platform_messaging`;
        const fresh = await ingestWhatsAppInbound(transaction, {
          ...input,
          text: "Fictional Meta genuinely new request",
          providerEventId: `fixture-meta-event-new-${suffix}`,
          providerMessageId: `fixture-meta-new-${suffix}`,
        });
        await transaction`SET LOCAL ROLE platform_web`;
        expect(fresh).toMatchObject({
          conversationId: first.conversationId,
          inserted: true,
        });
        expect(
          (await listConversations(transaction)).map((item) => item.id),
        ).toEqual([first.conversationId]);
      });
    });
  },
);
