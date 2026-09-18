import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  createSimulatorBroadcast,
  enqueueSimulatorBroadcast,
  acceptWhatsAppWebhook,
} from "@or-on/crm";

import { createMessagingStore } from "../src/database.js";
import {
  MetaWhatsAppProvider,
  SimulatorWhatsAppProvider,
  type WhatsAppMediaDownloadRequest,
  type WhatsAppSendRequest,
} from "../src/providers.js";

const databaseUrl = process.env.MESSAGING_WORKER_TEST_DATABASE_URL;
const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";

async function createWhatsAppContactFixture(
  transaction: postgres.TransactionSql,
  label: string,
) {
  await transaction`
    INSERT INTO tenants(id, name, slug, status)
    VALUES(
      ${tenantId}::uuid,
      'Fictional messaging worker tenant',
      'messaging-worker-fixture',
      'active'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await transaction`
    INSERT INTO users(id, email, display_name, status)
    VALUES(
      ${userId}::uuid,
      'messaging-worker-fixture@example.invalid',
      'Fictional messaging worker owner',
      'active'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await transaction`
    INSERT INTO memberships(tenant_id, user_id, role)
    VALUES(${tenantId}::uuid, ${userId}::uuid, 'owner')
    ON CONFLICT (tenant_id, user_id) DO NOTHING
  `;
  const suffix = randomUUID();
  const phone = `+1202${String(
    BigInt(`0x${suffix.replaceAll("-", "").slice(0, 9)}`) % 10_000_000n,
  ).padStart(7, "0")}`;
  const contacts = await transaction<{ id: string }[]>`
    INSERT INTO crm.contacts(
      tenant_id, created_by_user_id, name, whatsapp_consent
    ) VALUES(
      ${tenantId}::uuid, ${userId}::uuid, ${label}, 'granted'
    ) RETURNING id
  `;
  const contactId = contacts[0]?.id;
  if (contactId === undefined)
    throw new Error("WhatsApp contact fixture failed");
  const identities = await transaction<{ id: string }[]>`
    INSERT INTO crm.contact_channel_identities(
      tenant_id, contact_id, channel, normalized_value, display_value,
      validation_status, is_primary
    ) VALUES(
      ${tenantId}::uuid, ${contactId}::uuid, 'whatsapp', ${phone}, ${phone},
      'valid', true
    ) RETURNING id
  `;
  const identityId = identities[0]?.id;
  if (identityId === undefined)
    throw new Error("WhatsApp identity fixture failed");
  return { contactId, identityId, phone };
}

describe.skipIf(databaseUrl === undefined)("durable messaging worker", () => {
  it("claims and completes simulator broadcast recipients idempotently", async () => {
    if (databaseUrl === undefined)
      throw new Error("MESSAGING_WORKER_TEST_DATABASE_URL is required");
    const admin = postgres(databaseUrl, { max: 1, prepare: false });
    let broadcastId: string | undefined;
    try {
      broadcastId = await admin.begin(async (transaction) => {
        await transaction`
          SELECT set_config('app.current_tenant', ${tenantId}, true),
                 set_config('app.current_user', ${userId}, true),
                 set_config('app.current_role', 'owner', true)
        `;
        await createWhatsAppContactFixture(
          transaction,
          "Fictional durable worker recipient",
        );
        await transaction`
          INSERT INTO messaging.channels(
            tenant_id, kind, provider, provider_account_id, status
          ) VALUES(
            ${tenantId}::uuid, 'whatsapp', 'simulator',
            ${`worker-simulator-${randomUUID()}`}, 'active'
          )
        `;
        const id = await createSimulatorBroadcast(
          transaction,
          userId,
          "Fictional durable worker test",
          "Simulator-only durable delivery",
        );
        expect(
          await enqueueSimulatorBroadcast(transaction, id),
        ).toBeGreaterThan(0);
        return id;
      });

      const store = createMessagingStore(
        databaseUrl,
        "phase4-live-worker",
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: new MetaWhatsAppProvider({
            enabled: false,
            accessToken: undefined,
            graphApiVersion: undefined,
            phoneNumberId: undefined,
          }),
        },
        undefined,
        { simulatorEnabled: true },
      );
      try {
        expect(await store.processAvailable()).toBeGreaterThan(0);
        // The worker holds one lease at a time, so each recipient is a turn.
        let remaining = 1;
        for (let turn = 0; turn < 200 && remaining > 0; turn += 1)
          remaining = await store.processAvailable();
        expect(remaining).toBe(0);
      } finally {
        await store.close();
      }
      const rows = await admin<
        { status: string; delivered_count: number; total_recipients: number }[]
      >`
        SELECT status, delivered_count, total_recipients
        FROM messaging.broadcasts WHERE id = ${broadcastId}::uuid
      `;
      expect(rows[0]?.status).toBe("sent");
      expect(rows[0]?.delivered_count).toBeGreaterThan(0);
    } finally {
      if (broadcastId !== undefined) {
        await admin`
          DELETE FROM ops.jobs WHERE payload ->> 'broadcastId' = ${broadcastId}
        `;
        await admin`
          DELETE FROM platform.campaigns WHERE id = ${broadcastId}::uuid
             OR id = (SELECT campaign_id FROM messaging.broadcasts WHERE id = ${broadcastId}::uuid)
        `;
      }
      await admin.end({ timeout: 2 });
    }
  });

  it("refuses a queued WhatsApp send when the tenant module is disabled before claim", async () => {
    if (databaseUrl === undefined)
      throw new Error("MESSAGING_WORKER_TEST_DATABASE_URL is required");
    const admin = postgres(databaseUrl, { max: 1, prepare: false });
    let broadcastId: string | undefined;
    const send = vi.fn(() =>
      Promise.reject(new Error("disabled module must not call the provider")),
    );
    try {
      broadcastId = await admin.begin(async (transaction) => {
        await transaction`
          SELECT set_config('app.current_tenant', ${tenantId}, true),
                 set_config('app.current_user', ${userId}, true),
                 set_config('app.current_role', 'owner', true)
        `;
        await createWhatsAppContactFixture(
          transaction,
          "Fictional disabled-module recipient",
        );
        await transaction`
          INSERT INTO messaging.channels(
            tenant_id,kind,provider,provider_account_id,status
          ) VALUES(
            ${tenantId}::uuid,'whatsapp','simulator',
            ${`disabled-module-${randomUUID()}`},'active'
          )
        `;
        const id = await createSimulatorBroadcast(
          transaction,
          userId,
          "Fictional queued-before-disable test",
          "This must never reach a provider",
        );
        expect(
          await enqueueSimulatorBroadcast(transaction, id),
        ).toBeGreaterThan(0);
        return id;
      });
      await admin`
        UPDATE platform.tenant_feature_entitlements SET enabled=false
        WHERE tenant_id=${tenantId}::uuid AND feature_key='whatsapp'
      `;
      const store = createMessagingStore(
        databaseUrl,
        `disabled-module-${randomUUID()}`,
        {
          simulator: { name: "simulator", send },
          meta: {
            name: "meta",
            send: vi.fn(() => Promise.reject(new Error("must not send"))),
          },
        },
        undefined,
        { simulatorEnabled: true },
      );
      try {
        for (let turn = 0; turn < 200; turn += 1) {
          await store.processAvailable();
          const pending = await admin<{ count: number }[]>`
            SELECT count(*)::integer AS count FROM ops.jobs
            WHERE payload->>'broadcastId'=${broadcastId}
              AND status IN ('queued','running')
          `;
          if (pending[0]?.count === 0) break;
        }
      } finally {
        await store.close();
      }
      expect(send).not.toHaveBeenCalled();
      const refused = await admin<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM ops.jobs
        WHERE payload->>'broadcastId'=${broadcastId} AND status='dead'
          AND last_error_safe='tenant_feature_disabled'
      `;
      expect(refused[0]?.count).toBeGreaterThan(0);
    } finally {
      await admin`
        UPDATE platform.tenant_feature_entitlements SET enabled=true
        WHERE tenant_id=${tenantId}::uuid AND feature_key='whatsapp'
      `;
      if (broadcastId !== undefined) {
        await admin`
          DELETE FROM ops.jobs WHERE payload->>'broadcastId'=${broadcastId}
        `;
        await admin`
          DELETE FROM platform.campaigns WHERE id=${broadcastId}::uuid
             OR id=(SELECT campaign_id FROM messaging.broadcasts WHERE id=${broadcastId}::uuid)
        `;
      }
      await admin.end({ timeout: 2 });
    }
  });

  it("persists a mocked Meta identifier without making the request in a transaction", async () => {
    if (databaseUrl === undefined)
      throw new Error("MESSAGING_WORKER_TEST_DATABASE_URL is required");
    const admin = postgres(databaseUrl, { max: 1, prepare: false });
    let requestId: string | undefined;
    let messageId: string | undefined;
    let conversationId: string | undefined;
    const fixtureId = randomUUID();
    const providerMessageId = `wamid.mocked-${fixtureId}`;
    try {
      const seeded = await admin.begin(async (transaction) => {
        await transaction`
          SELECT set_config('app.current_tenant', ${tenantId}, true),
                 set_config('app.current_user', ${userId}, true),
                 set_config('app.current_role', 'owner', true)
        `;
        const contact = await createWhatsAppContactFixture(
          transaction,
          "Fictional mocked Meta recipient",
        );
        const channels = await transaction<{ id: string }[]>`
          INSERT INTO messaging.channels
            (tenant_id, kind, provider, provider_account_id, display_address, status, configuration)
          VALUES (platform.current_tenant_id(), 'whatsapp', 'meta', '1312069101984418',
                  'Mock Meta test', 'active',
                  '{"phoneNumberId":"1312069101984418","wabaId":"1507601250680263","graphApiVersion":"v26.0"}'::jsonb)
          ON CONFLICT (provider, provider_account_id) WHERE provider_account_id IS NOT NULL
          DO UPDATE SET status = 'active' RETURNING id
        `;
        const channelId = channels[0]?.id;
        if (channelId === undefined)
          throw new Error("Meta channel fixture failed");
        const conversations = await transaction<{ id: string }[]>`
          INSERT INTO messaging.conversations (tenant_id, channel_id, contact_id, status, customer_service_window_expires_at)
          VALUES (platform.current_tenant_id(), ${channelId}::uuid, ${contact.contactId}::uuid, 'open',CURRENT_TIMESTAMP+INTERVAL '1 hour')
          ON CONFLICT (tenant_id, channel_id, contact_id) DO UPDATE SET status = 'open',
            customer_service_window_expires_at=EXCLUDED.customer_service_window_expires_at
          RETURNING id
        `;
        const conversation = conversations[0]?.id;
        if (conversation === undefined)
          throw new Error("Meta conversation fixture failed");
        const messages = await transaction<{ id: string }[]>`
          INSERT INTO messaging.messages
            (tenant_id, conversation_id, direction, sender_type, sender_user_id,
             content_type, content_text, provider, status)
          VALUES (platform.current_tenant_id(), ${conversation}::uuid, 'outbound', 'user',
                  ${userId}::uuid, 'text', 'Fictional worker test', 'meta', 'queued')
          RETURNING id
        `;
        const message = messages[0]?.id;
        if (message === undefined) throw new Error("message fixture failed");
        const requests = await transaction<{ id: string }[]>`
          INSERT INTO messaging.outbound_requests
            (tenant_id, conversation_id, message_id, channel_id, recipient_identity_id, recipient_address,
             requested_by_user_id, provider, message_kind, explicitly_confirmed, idempotency_key)
          VALUES (platform.current_tenant_id(), ${conversation}::uuid, ${message}::uuid,
                  ${channelId}::uuid, ${contact.identityId}::uuid, ${contact.phone}, ${userId}::uuid,
                  'meta', 'text', true, ${`worker-meta-${fixtureId}`}) RETURNING id
        `;
        const request = requests[0]?.id;
        if (request === undefined) throw new Error("request fixture failed");
        await transaction`
          INSERT INTO ops.jobs
            (tenant_id, queue, job_type, reference_type, reference_id, payload,
             idempotency_key, max_attempts)
          VALUES (platform.current_tenant_id(), 'messaging', 'whatsapp.outbound.send',
                  'outbound_request', ${request}::uuid, jsonb_build_object('requestId', ${request}::uuid),
                  ${`worker-meta-${fixtureId}`}, 2)
        `;
        return { request, message, conversation };
      });
      requestId = seeded.request;
      messageId = seeded.message;
      conversationId = seeded.conversation;
      const metaSend = vi.fn(async (request: WhatsAppSendRequest) => {
        await request.beforeAttempt?.();
        return { messageId: providerMessageId };
      });
      const store = createMessagingStore(databaseUrl, "phase6-meta-worker", {
        simulator: new SimulatorWhatsAppProvider(),
        meta: { name: "meta", send: metaSend },
      });
      try {
        expect(await store.processAvailable()).toBeGreaterThan(0);
        let remaining = 1;
        for (let turn = 0; turn < 200 && remaining > 0; turn += 1)
          remaining = await store.processAvailable();
        expect(remaining).toBe(0);
        const rawBody = Buffer.from(
          JSON.stringify({
            entry: [
              {
                id: "1507601250680263",
                changes: [
                  {
                    value: {
                      metadata: { phone_number_id: "1312069101984418" },
                      statuses: [
                        {
                          id: providerMessageId,
                          status: "delivered",
                          timestamp: "1788364800",
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          }),
        );
        const secret = "fictional-worker-webhook-secret";
        const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
        await acceptWhatsAppWebhook(databaseUrl, rawBody, signature, secret);
        await acceptWhatsAppWebhook(databaseUrl, rawBody, signature, secret);
        expect(await store.processAvailable()).toBeGreaterThan(0);
        remaining = 1;
        for (let turn = 0; turn < 200 && remaining > 0; turn += 1)
          remaining = await store.processAvailable();
        expect(remaining).toBe(0);
      } finally {
        await store.close();
      }
      expect(metaSend).toHaveBeenCalledOnce();
      const state = await admin<
        { status: string; provider_message_id: string | null }[]
      >`
        SELECT status, provider_message_id FROM messaging.outbound_requests
        WHERE id = ${requestId}::uuid
      `;
      expect(state[0]).toEqual({
        status: "delivered",
        provider_message_id: providerMessageId,
      });
      const deliveries = await admin<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM messaging.message_delivery_events
        WHERE message_id = ${messageId}::uuid AND status = 'delivered'
      `;
      expect(deliveries[0]?.count).toBe(1);
    } finally {
      await admin.begin(async (transaction) => {
        await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        if (requestId !== undefined)
          await transaction`DELETE FROM ops.jobs WHERE reference_id = ${requestId}`;
        if (requestId !== undefined)
          await transaction`DELETE FROM messaging.outbound_requests WHERE id = ${requestId}::uuid`;
        if (messageId !== undefined)
          await transaction`DELETE FROM messaging.messages WHERE id = ${messageId}::uuid`;
        if (conversationId !== undefined)
          await transaction`DELETE FROM messaging.conversations WHERE id = ${conversationId}::uuid`;
      });
      await admin.end({ timeout: 2 });
    }
  });

  it("retrieves inbound media without a Field Service tenant configuration", async () => {
    if (databaseUrl === undefined)
      throw new Error("MESSAGING_WORKER_TEST_DATABASE_URL is required");
    const admin = postgres(databaseUrl, { max: 1, prepare: false });
    const localRoot = await mkdtemp(join(tmpdir(), "oron-inbox-media-"));
    const fixture = randomUUID().replaceAll("-", "");
    const mediaTenantId = randomUUID();
    const phoneNumberId = `9${BigInt(`0x${fixture.slice(0, 14)}`)
      .toString()
      .slice(0, 14)}`;
    const sender = `+1202${String(
      BigInt(`0x${fixture.slice(14, 23)}`) % 10_000_000n,
    ).padStart(7, "0")}`;
    const providerMessageId = `wamid.mock-media-${fixture}`;
    const providerMediaId = `media-${fixture}`;
    const secret = `fixture-secret-${fixture}`;
    const bytes = Buffer.from("%PDF-1.4\nFictional inbox media\n%%EOF");
    try {
      await admin`
        INSERT INTO tenants(id, name, slug)
        VALUES (${mediaTenantId}::uuid, 'Fictional media tenant', ${`media-${fixture}`})
      `;
      await admin`
        INSERT INTO messaging.channels(
          tenant_id, kind, provider, provider_account_id, display_address,
          status, mirror_inbound_media, configuration
        ) VALUES (
          ${mediaTenantId}::uuid, 'whatsapp', 'meta', ${phoneNumberId},
          'Mock media account', 'active', true,
          ${admin.json({
            phoneNumberId,
            wabaId: `8${fixture.slice(0, 14)}`,
            graphApiVersion: "v26.0",
          })}
        )
      `;
      expect(
        await admin<{ count: number }[]>`
          SELECT count(*)::integer AS count
          FROM service.tenant_configuration
          WHERE tenant_id=${mediaTenantId}::uuid
        `,
      ).toEqual([{ count: 0 }]);
      const rawBody = Buffer.from(
        JSON.stringify({
          entry: [
            {
              id: `8${fixture.slice(0, 14)}`,
              changes: [
                {
                  value: {
                    metadata: { phone_number_id: phoneNumberId },
                    contacts: [
                      {
                        wa_id: sender.slice(1),
                        profile: { name: "Media sender" },
                      },
                    ],
                    messages: [
                      {
                        from: sender.slice(1),
                        id: providerMessageId,
                        timestamp: "1788364800",
                        type: "document",
                        document: {
                          id: providerMediaId,
                          mime_type: "application/pdf",
                          filename: "invoice.pdf",
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      );
      const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
      await acceptWhatsAppWebhook(databaseUrl, rawBody, signature, secret);
      const downloadMedia = vi.fn(
        async (request: WhatsAppMediaDownloadRequest) => {
          await request.beforeAttempt?.();
          return {
            bytes,
            contentType: "application/pdf" as const,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        },
      );
      const store = createMessagingStore(
        databaseUrl,
        `media-worker-${fixture}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: vi.fn(() =>
              Promise.reject(
                new Error("media test must not send provider messages"),
              ),
            ),
            downloadMedia,
          },
        },
        undefined,
        {
          realWhatsAppEnabled: true,
          privateObjectStorage: { localRoot },
        },
      );
      try {
        for (let turn = 0; turn < 20; turn += 1) {
          await store.processAvailable();
          const status = await admin<{ status: string }[]>`
            SELECT job.status FROM ops.jobs job
            JOIN messaging.messages message ON message.id=job.reference_id
            WHERE message.provider_message_id=${providerMessageId}
              AND job.job_type='whatsapp.media.retrieve'
          `;
          if (status[0]?.status === "succeeded") break;
        }
      } finally {
        await store.close();
      }
      expect(downloadMedia).toHaveBeenCalledOnce();
      const stored = await admin<
        {
          retrieval_status: string | null;
          owner_type: string;
          owner_id: string;
          object_status: string;
          content_type: string;
        }[]
      >`
        SELECT message.structured_content->>'retrievalStatus' AS retrieval_status,
               object.owner_type, object.owner_id,
               object.status AS object_status, object.content_type
        FROM messaging.messages message
        JOIN objects.object_metadata object ON object.id=message.object_id
        WHERE message.provider_message_id=${providerMessageId}
      `;
      expect(stored[0]).toMatchObject({
        retrieval_status: "available",
        owner_type: "message",
        object_status: "available",
        content_type: "application/pdf",
      });
      expect(stored[0]?.owner_id).toBeDefined();
      expect(
        await admin<{ count: number }[]>`
          SELECT count(*)::integer AS count
          FROM service.report_attachments attachment
          JOIN messaging.messages message ON message.id=attachment.message_id
          WHERE message.provider_message_id=${providerMessageId}
        `,
      ).toEqual([{ count: 0 }]);
    } finally {
      await admin.begin(async (transaction) => {
        await transaction`
          UPDATE messaging.messages SET object_id=NULL
          WHERE tenant_id=${mediaTenantId}::uuid
        `;
        // Conversations retain their contact through a restrictive composite
        // foreign key. Remove them before the tenant cascade reaches contacts.
        await transaction`
          DELETE FROM messaging.conversations
          WHERE tenant_id=${mediaTenantId}::uuid
        `;
        await transaction`
          DELETE FROM tenants WHERE id=${mediaTenantId}::uuid
        `;
      });
      await admin.end({ timeout: 2 });
      await rm(localRoot, { recursive: true, force: true });
    }
  });
});
