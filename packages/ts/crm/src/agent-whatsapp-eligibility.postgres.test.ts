import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  createAgentProfileDraft,
  createAgentProfileRevision,
  listAgentProfiles,
  publishAgentProfile,
  rebindAgentConversations,
  setDefaultWhatsAppAgent,
} from "./cross-channel.js";
import { setConversationOwnership } from "./messaging.js";

const databaseUrl = process.env.CRM_TEST_DATABASE_URL;

interface Fixture {
  tenantId: string;
  userId: string;
  profileId: string;
  versionId: string;
  conversationId: string;
}

function ownedDatabase() {
  if (databaseUrl === undefined)
    throw new Error("CRM_TEST_DATABASE_URL required");
  const target = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    !/^\/oron_(ui_preview|crm)_[a-f0-9]+$/u.test(target.pathname)
  )
    throw new Error("Only owned fictional databases are permitted");
  return postgres(databaseUrl, { max: 2, prepare: false });
}

async function context(
  sql: postgres.TransactionSql,
  fixture: Pick<Fixture, "tenantId" | "userId">,
) {
  await sql`SET LOCAL ROLE platform_web`;
  await sql`SELECT set_config('app.current_tenant',${fixture.tenantId},true),
                   set_config('app.current_user',${fixture.userId},true),
                   set_config('app.current_role','owner',true)`;
}

async function fixture(database: postgres.Sql): Promise<Fixture> {
  return database.begin(async (sql) => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    await sql`INSERT INTO tenants(id,name,slug,status)
      VALUES(${tenantId}::uuid,'Fictional eligibility tenant',${`eligibility-${tenantId}`},'active')`;
    await sql`INSERT INTO users(id,email,display_name,status)
      VALUES(${userId}::uuid,${`eligibility-${userId}@example.invalid`},'Fictional owner','active')`;
    await sql`INSERT INTO memberships(tenant_id,user_id,role)
      VALUES(${tenantId}::uuid,${userId}::uuid,'owner')`;
    await sql`INSERT INTO crm.tenant_settings(tenant_id) VALUES(${tenantId}::uuid)`;
    await context(sql, { tenantId, userId });
    const profileId = await createAgentProfileDraft(sql, userId, {
      name: "Fictional eligibility agent",
      systemPrompt: "Handle fictional messages.",
      channels: ["whatsapp"],
    });
    expect(await publishAgentProfile(sql, userId, profileId)).toBe(true);
    expect(await setDefaultWhatsAppAgent(sql, userId, profileId)).toBe(true);
    const [version] = await sql<
      { id: string }[]
    >`SELECT id FROM agents.agent_profile_versions WHERE agent_profile_id=${profileId}::uuid`;
    const [channel] = await sql<
      { id: string }[]
    >`INSERT INTO messaging.channels(tenant_id,kind,provider,provider_account_id,status)
      VALUES(${tenantId}::uuid,'whatsapp','simulator',${`eligibility-${tenantId}`},'active') RETURNING id`;
    const [contact] = await sql<
      { id: string }[]
    >`INSERT INTO crm.contacts(tenant_id,created_by_user_id,name)
      VALUES(${tenantId}::uuid,${userId}::uuid,'Fictional customer') RETURNING id`;
    if (!version || !channel || !contact)
      throw new Error("fixture setup failed");
    const [conversation] = await sql<
      { id: string }[]
    >`INSERT INTO messaging.conversations(tenant_id,channel_id,contact_id,status)
      VALUES(${tenantId}::uuid,${channel.id}::uuid,${contact.id}::uuid,'open') RETURNING id`;
    if (!conversation) throw new Error("fixture conversation absent");
    expect(
      await setConversationOwnership(
        sql,
        conversation.id,
        userId,
        "ai",
        version.id,
      ),
    ).toBe(true);
    return {
      tenantId,
      userId,
      profileId,
      versionId: version.id,
      conversationId: conversation.id,
    };
  });
}

async function baseline(database: postgres.Sql, record: Fixture) {
  // Same baseline semantics as the migration: versions already published at
  // review time remain approved; subsequent publications require review.
  await database`INSERT INTO platform.tenant_configuration_releases(tenant_id,version,status,configuration,approved_at)
    VALUES(${record.tenantId}::uuid,1,'published','{}'::jsonb,clock_timestamp())`;
}

async function revision(
  database: postgres.Sql,
  record: Fixture,
  channels: ("voice" | "whatsapp")[],
) {
  return database.begin(async (sql) => {
    await context(sql, record);
    const created = await createAgentProfileRevision(
      sql,
      record.userId,
      record.profileId,
      {
        baseVersionId: record.versionId,
        systemPrompt: "Revised fictional instructions.",
        channels,
      },
    );
    if (!created) throw new Error("revision absent");
    expect(
      await publishAgentProfile(sql, record.userId, record.profileId),
    ).toBe(true);
    return created.versionId;
  });
}

async function ownershipBoundary(database: postgres.Sql, record: Fixture) {
  const [boundary] = await database<
    {
      mode: string;
      epoch: number;
      version: string | null;
      actor: string | null;
      enabled_at: string | null;
    }[]
  >`SELECT ownership_mode AS mode,ownership_epoch::int AS epoch,
       ai_agent_profile_version_id AS version,ai_enabled_by_user_id AS actor,
       ai_enabled_at::text AS enabled_at
     FROM messaging.conversations WHERE id=${record.conversationId}::uuid`;
  if (!boundary) throw new Error("conversation boundary absent");
  return boundary;
}

describe.skipIf(databaseUrl === undefined)(
  "approved WhatsApp versions under actual RLS",
  () => {
    it("keeps the current AI boundary and menu choice on repeated assignment while withdrawing stale handoffs", async () => {
      const database = ownedDatabase();
      try {
        const record = await fixture(database);
        const before = await ownershipBoundary(database, record);
        const generation = randomUUID();
        await database`INSERT INTO platform.whatsapp_opening_menu_state
          (tenant_id,conversation_id,ownership_epoch,status,route_intent,generation)
          VALUES(${record.tenantId}::uuid,${record.conversationId}::uuid,
            ${before.epoch},'chosen','support',${generation}::uuid)`;
        const handoffIds = [];
        for (const status of ["pending", "accepted"]) {
          const [handoff] = await database<{ id: string }[]>`
            INSERT INTO automation.handoffs(tenant_id,contact_id,conversation_id,
              requested_by_user_id,source_channel,reason_safe,status,idempotency_key)
            SELECT tenant_id,contact_id,id,${record.userId}::uuid,'whatsapp',
              'Fictional stale handoff',${status},${randomUUID()}
            FROM messaging.conversations WHERE id=${record.conversationId}::uuid
            RETURNING id`;
          if (!handoff) throw new Error("handoff fixture absent");
          handoffIds.push(handoff.id);
        }
        // Separate transactions matter: a same-transaction CURRENT_TIMESTAMP
        // would conceal the needless ownership change in this regression.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await database.begin(async (sql) => {
            await context(sql, record);
            expect(
              await setConversationOwnership(
                sql,
                record.conversationId,
                record.userId,
                "ai",
                record.versionId,
              ),
            ).toBe(true);
          });
          expect(await ownershipBoundary(database, record)).toEqual(before);
        }
        const [menu] = await database<
          { current: boolean; status: string; generation: string }[]
        >`SELECT state.ownership_epoch=conversation.ownership_epoch AS current,
            state.status,state.generation
          FROM platform.whatsapp_opening_menu_state state
          JOIN messaging.conversations conversation ON conversation.id=state.conversation_id
          WHERE conversation.id=${record.conversationId}::uuid`;
        expect(menu).toEqual({ current: true, status: "chosen", generation });
        const handoffs = await database<
          { status: string; resolved: boolean }[]
        >`
          SELECT status,resolved_at IS NOT NULL AS resolved FROM automation.handoffs
          WHERE conversation_id=${record.conversationId}::uuid`;
        expect(handoffs).toEqual([
          { status: "cancelled", resolved: true },
          { status: "cancelled", resolved: true },
        ]);
        const audits = await database<
          {
            actor_user_id: string;
            metadata: { agentVersionId: string; cancelledHandoffIds: string[] };
          }[]
        >`SELECT actor_user_id,metadata FROM audit.records
          WHERE target_id=${record.conversationId}::uuid AND action='conversation.ai_resumed'`;
        expect(audits).toHaveLength(3);
        expect(
          audits.every(
            (audit) =>
              audit.actor_user_id === record.userId &&
              audit.metadata.agentVersionId === record.versionId,
          ),
        ).toBe(true);
        expect(
          audits.flatMap((audit) => audit.metadata.cancelledHandoffIds).sort(),
        ).toEqual(handoffIds.sort());
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("fences prior AI work when a human returns control to the same agent", async () => {
      const database = ownedDatabase();
      try {
        const record = await fixture(database);
        const before = await ownershipBoundary(database, record);
        await database.begin(async (sql) => {
          await context(sql, record);
          expect(
            await setConversationOwnership(
              sql,
              record.conversationId,
              record.userId,
              "human",
            ),
          ).toBe(true);
        });
        expect(await ownershipBoundary(database, record)).toEqual({
          mode: "human",
          epoch: before.epoch + 1,
          version: null,
          actor: null,
          enabled_at: null,
        });
        await database.begin(async (sql) => {
          await context(sql, record);
          expect(
            await setConversationOwnership(
              sql,
              record.conversationId,
              record.userId,
              "ai",
              record.versionId,
            ),
          ).toBe(true);
        });
        const resumed = await ownershipBoundary(database, record);
        expect(resumed).toMatchObject({
          mode: "ai",
          epoch: before.epoch + 2,
          version: record.versionId,
          actor: record.userId,
        });
        expect(resumed.enabled_at).not.toBe(before.enabled_at);
        expect(resumed.enabled_at).not.toBeNull();
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("advances the boundary when the consenting actor or approved agent changes", async () => {
      const database = ownedDatabase();
      try {
        const record = await fixture(database);
        const before = await ownershipBoundary(database, record);
        const actor = randomUUID();
        await database`INSERT INTO users(id,email,display_name,status)
          VALUES(${actor}::uuid,${`eligibility-${actor}@example.invalid`},'Second fictional owner','active')`;
        await database`INSERT INTO memberships(tenant_id,user_id,role)
          VALUES(${record.tenantId}::uuid,${actor}::uuid,'owner')`;
        await database.begin(async (sql) => {
          await context(sql, { ...record, userId: actor });
          expect(
            await setConversationOwnership(
              sql,
              record.conversationId,
              actor,
              "ai",
              record.versionId,
            ),
          ).toBe(true);
        });
        const actorChanged = await ownershipBoundary(database, record);
        expect(actorChanged).toMatchObject({
          mode: "ai",
          epoch: before.epoch + 1,
          actor,
          version: record.versionId,
        });
        expect(actorChanged.enabled_at).not.toBe(before.enabled_at);
        const versionId = await revision(database, record, ["whatsapp"]);
        await database.begin(async (sql) => {
          await context(sql, { ...record, userId: actor });
          expect(
            await setConversationOwnership(
              sql,
              record.conversationId,
              actor,
              "ai",
              versionId,
            ),
          ).toBe(true);
        });
        const versionChanged = await ownershipBoundary(database, record);
        expect(versionChanged).toMatchObject({
          mode: "ai",
          epoch: actorChanged.epoch + 1,
          actor,
          version: versionId,
        });
        expect(versionChanged.enabled_at).not.toBe(actorChanged.enabled_at);
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("withdraws human handoffs on AI resume only in the active tenant", async () => {
      const database = ownedDatabase();
      try {
        const own = await fixture(database);
        const foreign = await fixture(database);
        for (const record of [own, foreign]) {
          await database.begin(async (sql) => {
            await context(sql, record);
            expect(
              await setConversationOwnership(
                sql,
                record.conversationId,
                record.userId,
                "human",
              ),
            ).toBe(true);
          });
        }
        await database.begin(async (sql) => {
          await context(sql, own);
          expect(
            await setConversationOwnership(
              sql,
              foreign.conversationId,
              own.userId,
              "ai",
              own.versionId,
            ),
          ).toBe(false);
          expect(
            await setConversationOwnership(
              sql,
              own.conversationId,
              own.userId,
              "ai",
              own.versionId,
            ),
          ).toBe(true);
          const handoffs = await sql<{ status: string; resolved: boolean }[]>`
            SELECT status,resolved_at IS NOT NULL AS resolved FROM automation.handoffs
            WHERE conversation_id=${own.conversationId}::uuid
          `;
          expect(handoffs).toEqual([{ status: "cancelled", resolved: true }]);
        });
        await database.begin(async (sql) => {
          await context(sql, foreign);
          const handoffs = await sql<{ status: string; resolved: boolean }[]>`
            SELECT status,resolved_at IS NOT NULL AS resolved FROM automation.handoffs
            WHERE conversation_id=${foreign.conversationId}::uuid
          `;
          expect(handoffs).toEqual([{ status: "accepted", resolved: false }]);
        });
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("keeps the approved WhatsApp pin current when a newer publication is unapproved", async () => {
      const database = ownedDatabase();
      try {
        const record = await fixture(database);
        await baseline(database, record);
        const unapproved = await revision(database, record, ["whatsapp"]);
        await database.begin(async (sql) => {
          await context(sql, record);
          const [approval] = await sql<
            { old: boolean; latest: boolean }[]
          >`SELECT
          platform.approved_agent_for_channel(${record.versionId}::uuid,'whatsapp') AS old,
          platform.approved_agent_for_channel(${unapproved}::uuid,'whatsapp') AS latest`;
          expect(approval).toEqual({ old: true, latest: false });
          const agent = (await listAgentProfiles(sql)).find(
            (row) => row.id === record.profileId,
          );
          expect(agent?.lifecycle.staleConversations).toBe(0);
          expect(agent?.whatsAppAssignableVersionId).toBe(record.versionId);
          expect(agent?.whatsAppAssignableVersion).toBe(1);
          expect(
            await rebindAgentConversations(
              sql,
              record.userId,
              record.profileId,
              record.versionId,
            ),
          ).toEqual({ versionId: record.versionId, rebound: 0 });
        });
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("never substitutes a voice-only publication for the approved WhatsApp target", async () => {
      const database = ownedDatabase();
      try {
        const record = await fixture(database);
        const voiceVersion = await revision(database, record, ["voice"]);
        await database.begin(async (sql) => {
          await context(sql, record);
          const agent = (await listAgentProfiles(sql)).find(
            (row) => row.id === record.profileId,
          );
          expect(agent?.publishedVersionId).toBe(voiceVersion);
          expect(agent?.whatsAppAssignableVersionId).toBe(record.versionId);
          expect(agent?.whatsAppAssignableVersion).toBe(1);
          expect(agent?.lifecycle.staleConversations).toBe(0);
          expect(
            await rebindAgentConversations(
              sql,
              record.userId,
              record.profileId,
              record.versionId,
            ),
          ).toEqual({ versionId: record.versionId, rebound: 0 });
        });
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("refuses an entirely unapproved default without changing the previous default", async () => {
      const database = ownedDatabase();
      try {
        const record = await fixture(database);
        await baseline(database, record);
        const unapproved = await database.begin(async (sql) => {
          await context(sql, record);
          const profile = await createAgentProfileDraft(sql, record.userId, {
            name: "Unreviewed fictional agent",
            systemPrompt: "Handle fictional messages.",
            channels: ["whatsapp"],
          });
          expect(await publishAgentProfile(sql, record.userId, profile)).toBe(
            true,
          );
          return profile;
        });
        await expect(
          database.begin(async (sql) => {
            await context(sql, record);
            return setDefaultWhatsAppAgent(sql, record.userId, unapproved);
          }),
        ).rejects.toThrow(/approved/u);
        const [settings] = await database<
          { id: string }[]
        >`SELECT whatsapp_ai_agent_profile_id AS id
        FROM crm.tenant_settings WHERE tenant_id=${record.tenantId}::uuid`;
        expect(settings?.id).toBe(record.profileId);
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("does not rebind or expose another tenant's profile", async () => {
      const database = ownedDatabase();
      try {
        const own = await fixture(database);
        const other = await fixture(database);
        await database.begin(async (sql) => {
          await context(sql, other);
          expect(
            (await listAgentProfiles(sql)).some(
              (row) => row.id === own.profileId,
            ),
          ).toBe(false);
          expect(
            await rebindAgentConversations(
              sql,
              other.userId,
              own.profileId,
              own.versionId,
            ),
          ).toBeNull();
        });
      } finally {
        await database.end({ timeout: 2 });
      }
    });
  },
);
