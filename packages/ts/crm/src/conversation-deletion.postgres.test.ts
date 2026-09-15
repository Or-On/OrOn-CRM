import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { deleteConversation } from "./messaging.js";

const databaseUrl =
  process.env.UI_TEST_DATABASE_URL ?? process.env.CRM_TEST_DATABASE_URL;
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
    await expect(
      sql.begin(async (transaction) => {
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
      }),
    ).rejects.toBeInstanceOf(ExpectedRollback);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function fixture(transaction: postgres.TransactionSql) {
  const suffix = randomUUID();
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
  return { contactId, conversationId, messageId };
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
                  'whatsapp', 'Fictional retained handoff', 'accepted',
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

    it("returns a clear conflict instead of deleting retained technician evidence", async () => {
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

        expect(
          await deleteConversation(transaction, record.conversationId, userId),
        ).toEqual({ status: "retained_evidence" });
        expect(
          await transaction`
            SELECT id FROM messaging.conversations
            WHERE id=${record.conversationId}::uuid
          `,
        ).toHaveLength(1);
        expect(
          await transaction`
            SELECT id FROM messaging.messages WHERE id=${record.messageId}::uuid
          `,
        ).toHaveLength(1);
      });
    });
  },
);
