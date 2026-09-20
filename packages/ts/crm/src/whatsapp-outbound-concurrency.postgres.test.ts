import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { deleteConversation } from "./messaging.js";
import {
  queueWhatsAppOutbound,
  type WhatsAppOutboundInput,
} from "./whatsapp-outbound.js";

const databaseUrl = process.env.CRM_TEST_DATABASE_URL;

interface Fixture {
  readonly conversationId: string;
  readonly initialMessageId: string;
  readonly tenantId: string;
  readonly userId: string;
}

function ownedDatabase() {
  if (databaseUrl === undefined)
    throw new Error("CRM_TEST_DATABASE_URL is required");
  const target = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    !/^\/oron_ui_preview_[a-f0-9]+$/u.test(target.pathname)
  )
    throw new Error("Only owned fictional databases are permitted");
  return postgres(databaseUrl, { max: 4, prepare: false });
}

async function runtimeContext(
  sql: postgres.TransactionSql,
  fixture: Pick<Fixture, "tenantId" | "userId">,
) {
  await sql`SET LOCAL ROLE platform_web`;
  await sql`SET LOCAL lock_timeout = '2s'`;
  await sql`SET LOCAL statement_timeout = '5s'`;
  await sql`
    SELECT set_config('app.current_tenant', ${fixture.tenantId}, true),
           set_config('app.current_user', ${fixture.userId}, true),
           set_config('app.current_role', 'owner', true)
  `;
}

async function createFixture(database: postgres.Sql): Promise<Fixture> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "");
  const recipientAddress = `+1555${suffix.replace(/\D/gu, "").padEnd(7, "0").slice(0, 7)}`;
  return database.begin(async (sql) => {
    await sql`
      INSERT INTO tenants(id,name,slug,status)
      VALUES(${tenantId}::uuid,'Fictional outbound race tenant',
             ${`outbound-race-${suffix}`},'active')
    `;
    await sql`
      INSERT INTO users(id,email,display_name,status)
      VALUES(${userId}::uuid,${`outbound-race-${suffix}@example.invalid`},
             'Fictional race owner','active')
    `;
    await sql`
      INSERT INTO memberships(tenant_id,user_id,role)
      VALUES(${tenantId}::uuid,${userId}::uuid,'owner')
    `;
    await sql`
      INSERT INTO platform.tenant_feature_entitlements(
        tenant_id,feature_key,available,granted_by_user_id,granted_at
      ) VALUES(
        ${tenantId}::uuid,'field_service',true,${userId}::uuid,CURRENT_TIMESTAMP
      )
    `;
    await sql`
      INSERT INTO service.tenant_configuration(tenant_id,enabled)
      VALUES(${tenantId}::uuid,true)
    `;
    await runtimeContext(sql, { tenantId, userId });
    const contacts = await sql<{ id: string }[]>`
      INSERT INTO crm.contacts(tenant_id,created_by_user_id,name)
      VALUES(platform.current_tenant_id(),${userId}::uuid,
             'Fictional outbound race contact')
      RETURNING id
    `;
    const contactId = contacts[0]?.id;
    if (contactId === undefined) throw new Error("fixture contact missing");
    const channels = await sql<{ id: string }[]>`
      INSERT INTO messaging.channels(
        tenant_id,kind,provider,display_address,provider_account_id,status
      ) VALUES(
        platform.current_tenant_id(),'whatsapp','simulator',
        'Fictional simulator sender',${`simulator-${suffix}`},'active'
      )
      RETURNING id
    `;
    const channelId = channels[0]?.id;
    if (channelId === undefined) throw new Error("fixture channel missing");
    await sql`
      INSERT INTO crm.contact_channel_identities(
        tenant_id,contact_id,channel,normalized_value,display_value,provider,
        provider_identity_id,validation_status,is_primary
      ) VALUES(
        platform.current_tenant_id(),${contactId}::uuid,'whatsapp',
        ${recipientAddress},${recipientAddress},'simulator',${recipientAddress},
        'valid',true
      )
    `;
    const conversations = await sql<{ id: string }[]>`
      INSERT INTO messaging.conversations(
        tenant_id,channel_id,contact_id,status
      ) VALUES(
        platform.current_tenant_id(),${channelId}::uuid,${contactId}::uuid,
        'open'
      )
      RETURNING id
    `;
    const conversationId = conversations[0]?.id;
    if (conversationId === undefined)
      throw new Error("fixture conversation missing");
    const messages = await sql<{ id: string }[]>`
      INSERT INTO messaging.messages(
        tenant_id,conversation_id,direction,sender_type,content_type,
        content_text,provider,status
      ) VALUES(
        platform.current_tenant_id(),${conversationId}::uuid,'inbound',
        'contact','text','Fictional retained inbound','simulator','received'
      )
      RETURNING id
    `;
    const initialMessageId = messages[0]?.id;
    if (initialMessageId === undefined)
      throw new Error("fixture message missing");
    await sql`
      INSERT INTO service.cases(
        tenant_id,reference,customer_contact_id,conversation_id,title,
        fault_description,created_by_user_id
      ) VALUES(
        platform.current_tenant_id(),${`FS-${suffix}`},${contactId}::uuid,
        ${conversationId}::uuid,'Fictional retained race case',
        'Synthetic evidence for an outbound/removal concurrency test',
        ${userId}::uuid
      )
    `;
    return { conversationId, initialMessageId, tenantId, userId };
  });
}

async function cleanupFixture(database: postgres.Sql, fixture: Fixture) {
  await database.begin(async (sql) => {
    await sql`SET LOCAL lock_timeout = '2s'`;
    await sql`SET LOCAL statement_timeout = '5s'`;
    // The synthetic case intentionally retains its conversation. Remove the
    // retaining evidence first so tenant cleanup does not rely on PostgreSQL's
    // unspecified cascade ordering across the contact/conversation graph.
    await sql`DELETE FROM support.tickets WHERE tenant_id=${fixture.tenantId}::uuid`;
    await sql`DELETE FROM service.cases WHERE tenant_id=${fixture.tenantId}::uuid`;
    await sql`DELETE FROM messaging.conversations WHERE tenant_id=${fixture.tenantId}::uuid`;
    await sql`DELETE FROM tenants WHERE id=${fixture.tenantId}::uuid`;
    await sql`DELETE FROM users WHERE id=${fixture.userId}::uuid`;
  });
}

function outboundInput(
  fixture: Fixture,
  idempotencyKey: string,
): WhatsAppOutboundInput {
  return {
    conversationId: fixture.conversationId,
    explicitlyConfirmed: false,
    idempotencyKey,
    kind: "text",
    provider: "simulator",
    realProviderEnabled: false,
    senderUserId: fixture.userId,
    text: "Fictional concurrent simulator reply",
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function within<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function startRemovalAndHold(database: postgres.Sql, fixture: Fixture) {
  const removed = deferred();
  const release = deferred();
  const outcome = database.begin(async (sql) => {
    await runtimeContext(sql, fixture);
    const result = await deleteConversation(
      sql,
      fixture.conversationId,
      fixture.userId,
    );
    removed.resolve();
    await release.promise;
    return result;
  });
  await within(
    removed.promise,
    "conversation removal did not reach its hold point",
  );
  return { outcome, release: release.resolve };
}

async function assertPending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 75));
  expect(settled).toBe(false);
}

describe.skipIf(databaseUrl === undefined)(
  "WhatsApp outbound/removal serialization on PostgreSQL",
  () => {
    it("does not queue a simulator reply from a stale read while retained evidence is removed", async () => {
      const database = ownedDatabase();
      let fixture: Fixture | undefined;
      let releaseRemoval: (() => void) | undefined;
      let removalOutcome: Promise<unknown> | undefined;
      try {
        fixture = await createFixture(database);
        const record = fixture;
        const removal = await startRemovalAndHold(database, record);
        releaseRemoval = removal.release;
        removalOutcome = removal.outcome;
        const attempt = database
          .begin(async (sql) => {
            await runtimeContext(sql, record);
            return queueWhatsAppOutbound(
              sql,
              outboundInput(record, `race-new:${randomUUID()}`),
            );
          })
          .then(
            (value) => ({ status: "fulfilled" as const, value }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );

        await assertPending(attempt);
        removal.release();
        await expect(
          within(removal.outcome, "conversation removal did not complete"),
        ).resolves.toEqual({
          status: "removed_retained_evidence",
        });
        const attempted = await within(
          attempt,
          "outbound attempt did not settle after conversation removal",
        );
        expect(attempted.status).toBe("rejected");
        if (attempted.status === "rejected")
          expect(attempted.error).toEqual(
            expect.objectContaining({
              message: "conversation is no longer available in the Inbox",
            }),
          );
        const rows = await database<
          { message_count: number; request_count: number }[]
        >`
          SELECT
            (SELECT count(*)::int FROM messaging.messages
             WHERE tenant_id=${fixture.tenantId}::uuid
               AND conversation_id=${fixture.conversationId}::uuid) AS message_count,
            (SELECT count(*)::int FROM messaging.outbound_requests
             WHERE tenant_id=${fixture.tenantId}::uuid
               AND conversation_id=${fixture.conversationId}::uuid) AS request_count
        `;
        expect(rows).toEqual([{ message_count: 1, request_count: 0 }]);
      } finally {
        releaseRemoval?.();
        if (removalOutcome !== undefined)
          await within(
            removalOutcome.catch(() => undefined),
            "conversation removal did not settle during cleanup",
          ).catch(() => undefined);
        if (fixture !== undefined) await cleanupFixture(database, fixture);
        await database.end({ timeout: 2 });
      }
    });

    it("does not expose an idempotent replay while retained evidence is being removed", async () => {
      const database = ownedDatabase();
      let fixture: Fixture | undefined;
      let releaseRemoval: (() => void) | undefined;
      let removalOutcome: Promise<unknown> | undefined;
      try {
        fixture = await createFixture(database);
        const record = fixture;
        const key = `race-replay:${randomUUID()}`;
        const input = outboundInput(record, key);
        const first = await database.begin(async (sql) => {
          await runtimeContext(sql, record);
          return queueWhatsAppOutbound(sql, input);
        });
        await database`
          UPDATE messaging.outbound_requests
          SET status='sent',completed_at=CURRENT_TIMESTAMP
          WHERE id=${first.requestId}::uuid
        `;
        await database`
          UPDATE messaging.messages SET status='sent'
          WHERE id=${first.messageId}::uuid
        `;
        await database`
          UPDATE ops.jobs SET status='succeeded',completed_at=CURRENT_TIMESTAMP
          WHERE reference_type='outbound_request'
            AND reference_id=${first.requestId}::uuid
        `;

        const removal = await startRemovalAndHold(database, record);
        releaseRemoval = removal.release;
        removalOutcome = removal.outcome;
        const replay = database
          .begin(async (sql) => {
            await runtimeContext(sql, record);
            return queueWhatsAppOutbound(sql, input);
          })
          .then(
            (value) => ({ status: "fulfilled" as const, value }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );

        await assertPending(replay);
        removal.release();
        await expect(
          within(removal.outcome, "conversation removal did not complete"),
        ).resolves.toEqual({
          status: "removed_retained_evidence",
        });
        const replayed = await within(
          replay,
          "outbound replay did not settle after conversation removal",
        );
        expect(replayed.status).toBe("rejected");
        if (replayed.status === "rejected")
          expect(replayed.error).toEqual(
            expect.objectContaining({
              message: "conversation is no longer available in the Inbox",
            }),
          );
        const requests = await database<{ count: number }[]>`
          SELECT count(*)::int AS count FROM messaging.outbound_requests
          WHERE tenant_id=${fixture.tenantId}::uuid
            AND conversation_id=${fixture.conversationId}::uuid
        `;
        expect(requests).toEqual([{ count: 1 }]);
      } finally {
        releaseRemoval?.();
        if (removalOutcome !== undefined)
          await within(
            removalOutcome.catch(() => undefined),
            "conversation removal did not settle during cleanup",
          ).catch(() => undefined);
        if (fixture !== undefined) await cleanupFixture(database, fixture);
        await database.end({ timeout: 2 });
      }
    });
  },
);
