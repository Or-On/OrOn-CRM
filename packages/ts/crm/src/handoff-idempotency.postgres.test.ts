import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  requestHandoff,
  transitionHandoff,
  type HandoffIdentityReferences,
  type SupportedChannel,
} from "./cross-channel.js";

const databaseUrl = process.env.READINESS_POSTGRES_URL;
class RollbackFixture extends Error {}

interface Fixture {
  tenantId: string;
  userId: string;
  otherUserId: string;
  contactId: string;
  otherContactId: string;
  references: HandoffIdentityReferences;
}

async function isolated(
  work: (sql: postgres.TransactionSql, fixture: Fixture) => Promise<void>,
) {
  if (!databaseUrl) throw new Error("isolated readiness database required");
  const target = new URL(databaseUrl);
  if (
    target.hostname !== "127.0.0.1" ||
    target.port !== "55439" ||
    target.pathname !== "/oron_readiness" ||
    target.username !== "platform_migrator"
  )
    throw new Error("only the owned readiness fixture is permitted");
  const database = postgres(databaseUrl, { max: 1, prepare: false });
  const tenantId = randomUUID();
  try {
    await expect(
      database.begin(async (sql) => {
        const userId = randomUUID();
        const otherUserId = randomUUID();
        const contactId = randomUUID();
        const otherContactId = randomUUID();
        const channelId = randomUUID();
        const conversationId = randomUUID();
        const definitionId = randomUUID();
        const versionId = randomUUID();
        const flowRunId = randomUUID();
        const sessionId = randomUUID();
        await sql`INSERT INTO tenants(id,name,slug,status)
          VALUES(${tenantId}::uuid,'Fictional handoff tenant',${`handoff-${tenantId}`},'active')`;
        for (const actor of [userId, otherUserId]) {
          await sql`INSERT INTO users(id,email,display_name,is_superuser,status)
            VALUES(${actor}::uuid,${`handoff-${actor}@example.invalid`},'Fictional operator',false,'active')`;
          await sql`INSERT INTO memberships(tenant_id,user_id,role)
            VALUES(${tenantId}::uuid,${actor}::uuid,'owner')`;
        }
        for (const contact of [contactId, otherContactId])
          await sql`INSERT INTO crm.contacts(id,tenant_id,name)
            VALUES(${contact}::uuid,${tenantId}::uuid,'Fictional handoff contact')`;
        await sql`INSERT INTO messaging.channels
          (id,tenant_id,kind,provider,display_address,provider_account_id,status)
          VALUES(${channelId}::uuid,${tenantId}::uuid,'whatsapp','simulator',
            'Fictional handoff channel',${`handoff-${channelId}`},'active')`;
        await sql`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,status)
          VALUES(${conversationId}::uuid,${tenantId}::uuid,${channelId}::uuid,${contactId}::uuid,'open')`;
        await sql`INSERT INTO automation.flow_definitions(id,tenant_id,name)
          VALUES(${definitionId}::uuid,${tenantId}::uuid,'Fictional handoff flow')`;
        await sql`INSERT INTO automation.flow_versions
          (id,tenant_id,flow_definition_id,version,schema_version,definition)
          VALUES(${versionId}::uuid,${tenantId}::uuid,${definitionId}::uuid,1,'1.0','{}')`;
        await sql`INSERT INTO automation.flow_runs(id,tenant_id,flow_version_id,contact_id,trigger_type)
          VALUES(${flowRunId}::uuid,${tenantId}::uuid,${versionId}::uuid,${contactId}::uuid,'fictional.fixture')`;
        await sql`INSERT INTO public.sessions
          (session_id,tenant_id,contact_id,provider,direction,room,status,flow_id)
          VALUES(${sessionId}::uuid,${tenantId}::uuid,${contactId}::uuid,'simulator',
            'outbound',${`handoff-${sessionId}`},'ended',${randomUUID()}::uuid)`;
        await sql`SET LOCAL ROLE platform_web`;
        await sql`SELECT set_config('app.current_tenant',${tenantId},true),
          set_config('app.current_user',${userId},true),set_config('app.current_role','owner',true)`;
        await work(sql, {
          tenantId,
          userId,
          otherUserId,
          contactId,
          otherContactId,
          references: { flowRunId, conversationId, sessionId },
        });
        throw new RollbackFixture();
      }),
    ).rejects.toBeInstanceOf(RollbackFixture);
    expect(
      await database`SELECT id FROM tenants WHERE id=${tenantId}::uuid`,
    ).toHaveLength(0);
  } finally {
    await database.end({ timeout: 2 });
  }
}

const reason = "Fictional customer requested a person";
const key = "fictional-handoff-idempotency";

describe.skipIf(!databaseUrl)(
  "handoff idempotency with actual PostgreSQL RLS",
  () => {
    it("preserves legacy null defaults and current accepted/resolved receipts on exact replay", async () =>
      isolated(async (sql, fixture) => {
        const { userId, contactId } = fixture;
        const requested = await requestHandoff(
          sql,
          userId,
          contactId,
          "whatsapp",
          ` ${reason} `,
          key,
        );
        expect(requested.status).toBe("pending");
        expect(
          await requestHandoff(
            sql,
            userId,
            contactId,
            "whatsapp",
            reason,
            key,
            {
              flowRunId: null,
              conversationId: null,
              sessionId: null,
            },
          ),
        ).toEqual(requested);
        for (const action of ["accept", "resolve"] as const) {
          const transitioned = await transitionHandoff(
            sql,
            requested.id,
            userId,
            action,
          );
          const replay = await requestHandoff(
            sql,
            userId,
            contactId,
            "whatsapp",
            reason,
            key,
          );
          expect(replay).toEqual(transitioned);
          expect(replay.status).toBe(
            action === "accept" ? "accepted" : "resolved",
          );
        }
        expect(
          await sql`SELECT id FROM automation.handoffs WHERE idempotency_key=${key}`,
        ).toHaveLength(1);
      }));

    it("replays exact non-null flow/conversation/session references without changing their identity", async () =>
      isolated(async (sql, fixture) => {
        const { userId, contactId, references } = fixture;
        const requested = await requestHandoff(
          sql,
          userId,
          contactId,
          "voice",
          reason,
          key,
          references,
        );
        expect(
          await requestHandoff(
            sql,
            userId,
            contactId,
            "voice",
            reason,
            key,
            references,
          ),
        ).toEqual(requested);
        expect(
          (
            await sql`SELECT flow_run_id,conversation_id,session_id FROM automation.handoffs WHERE id=${requested.id}::uuid`
          )[0],
        ).toMatchObject({
          flow_run_id: references.flowRunId,
          conversation_id: references.conversationId,
          session_id: references.sessionId,
        });
      }));

    it.each([
      "contact",
      "actor",
      "channel",
      "reason",
      "flowRunId",
      "conversationId",
      "sessionId",
      "removeFlowRunId",
      "removeConversationId",
      "removeSessionId",
    ] as const)(
      "rejects a changed %s without mutating the receipt or auditing a false request",
      async (changed) =>
        isolated(async (sql, fixture) => {
          const { userId, contactId, references } = fixture;
          const requested = await requestHandoff(
            sql,
            userId,
            contactId,
            "whatsapp",
            reason,
            key,
            references,
          );
          const changedReferences = { ...references };
          if (
            changed === "flowRunId" ||
            changed === "conversationId" ||
            changed === "sessionId"
          )
            changedReferences[changed] = randomUUID();
          if (changed === "removeFlowRunId") changedReferences.flowRunId = null;
          if (changed === "removeConversationId")
            changedReferences.conversationId = null;
          if (changed === "removeSessionId") changedReferences.sessionId = null;
          const channel: SupportedChannel =
            changed === "channel" ? "voice" : "whatsapp";
          const auditsBefore =
            await sql`SELECT id FROM audit.records WHERE target_id=${requested.id}::uuid`;
          await expect(
            requestHandoff(
              sql,
              changed === "actor" ? fixture.otherUserId : userId,
              changed === "contact" ? fixture.otherContactId : contactId,
              channel,
              changed === "reason" ? "Different fictional reason" : reason,
              key,
              changedReferences,
            ),
          ).rejects.toMatchObject({ code: "23505" });
          expect(
            await sql`SELECT id FROM audit.records WHERE target_id=${requested.id}::uuid`,
          ).toEqual(auditsBefore);
          expect(
            (
              await sql`SELECT contact_id,requested_by_user_id,source_channel,reason_safe,status,
        flow_run_id,conversation_id,session_id FROM automation.handoffs WHERE id=${requested.id}::uuid`
            )[0],
          ).toMatchObject({
            contact_id: contactId,
            requested_by_user_id: userId,
            source_channel: "whatsapp",
            reason_safe: reason,
            status: "pending",
            flow_run_id: references.flowRunId,
            conversation_id: references.conversationId,
            session_id: references.sessionId,
          });
          expect(
            await sql`SELECT id FROM automation.handoffs WHERE idempotency_key=${key}`,
          ).toHaveLength(1);
        }),
    );
  },
);
