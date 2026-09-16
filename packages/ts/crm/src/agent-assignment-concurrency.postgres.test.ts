import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  archiveAgentProfile,
  createAgentProfileDraft,
  publishAgentProfile,
  setDefaultWhatsAppAgent,
} from "./cross-channel.js";
import {
  assignDefaultWhatsAppAi,
  setConversationOwnership,
} from "./messaging.js";

const databaseUrl = process.env.CRM_TEST_DATABASE_URL;

interface Fixture {
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly conversationId: string;
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
  return database.begin(async (sql) => {
    await sql`
      INSERT INTO tenants(id,name,slug,status)
      VALUES(${tenantId}::uuid,'Fictional agent race tenant',
             ${`agent-race-${suffix}`},'active')
    `;
    await sql`
      INSERT INTO users(id,email,display_name,status)
      VALUES(${userId}::uuid,${`agent-race-${suffix}@example.invalid`},
             'Fictional agent race owner','active')
    `;
    await sql`
      INSERT INTO memberships(tenant_id,user_id,role)
      VALUES(${tenantId}::uuid,${userId}::uuid,'owner')
    `;
    await sql`INSERT INTO crm.tenant_settings(tenant_id) VALUES(${tenantId}::uuid)`;
    await runtimeContext(sql, { tenantId, userId });
    const agentId = await createAgentProfileDraft(sql, userId, {
      name: `Fictional race agent ${suffix}`,
      systemPrompt: "Handle synthetic WhatsApp test conversations safely.",
      channels: ["whatsapp"],
    });
    if (!(await publishAgentProfile(sql, userId, agentId)))
      throw new Error("fixture agent could not be published");
    if (!(await setDefaultWhatsAppAgent(sql, userId, agentId)))
      throw new Error("fixture agent could not be selected as default");
    const versions = await sql<{ id: string }[]>`
      SELECT id FROM agents.agent_profile_versions
      WHERE agent_profile_id=${agentId}::uuid
      ORDER BY version DESC LIMIT 1
    `;
    const agentVersionId = versions[0]?.id;
    if (agentVersionId === undefined)
      throw new Error("fixture agent version is unavailable");
    const contacts = await sql<{ id: string }[]>`
      INSERT INTO crm.contacts(tenant_id,created_by_user_id,name)
      VALUES(platform.current_tenant_id(),${userId}::uuid,
             'Fictional agent race contact')
      RETURNING id
    `;
    const contactId = contacts[0]?.id;
    if (contactId === undefined)
      throw new Error("fixture contact is unavailable");
    const channels = await sql<{ id: string }[]>`
      INSERT INTO messaging.channels(
        tenant_id,kind,provider,provider_account_id,status
      ) VALUES(
        platform.current_tenant_id(),'whatsapp','simulator',
        ${`agent-race-${suffix}`},'active'
      )
      RETURNING id
    `;
    const channelId = channels[0]?.id;
    if (channelId === undefined)
      throw new Error("fixture channel is unavailable");
    const conversations = await sql<{ id: string }[]>`
      INSERT INTO messaging.conversations(
        tenant_id,channel_id,contact_id,status
      ) VALUES(
        platform.current_tenant_id(),${channelId}::uuid,${contactId}::uuid,'open'
      )
      RETURNING id
    `;
    const conversationId = conversations[0]?.id;
    if (conversationId === undefined)
      throw new Error("fixture conversation is unavailable");
    return { agentId, agentVersionId, conversationId, tenantId, userId };
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(label)), 5_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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
  "agent archive/assignment serialization on PostgreSQL",
  () => {
    it("lets a committed assignment make a concurrent archive report active", async () => {
      const database = ownedDatabase();
      let fixture: Fixture | undefined;
      const assignmentReady = deferred();
      const releaseAssignment = deferred();
      let assignment: Promise<boolean> | undefined;
      try {
        fixture = await createFixture(database);
        const record = fixture;
        assignment = database.begin(async (sql) => {
          await runtimeContext(sql, record);
          const assigned = await setConversationOwnership(
            sql,
            record.conversationId,
            record.userId,
            "ai",
            record.agentVersionId,
          );
          assignmentReady.resolve();
          await releaseAssignment.promise;
          return assigned;
        });
        await within(
          assignmentReady.promise,
          "assignment did not reach hold point",
        );
        const archive = database.begin(async (sql) => {
          await runtimeContext(sql, record);
          return archiveAgentProfile(sql, record.userId, record.agentId);
        });
        await assertPending(archive);
        releaseAssignment.resolve();
        await expect(
          within(assignment, "assignment did not complete"),
        ).resolves.toBe(true);
        await expect(within(archive, "archive did not complete")).resolves.toBe(
          "active",
        );
      } finally {
        releaseAssignment.resolve();
        if (assignment !== undefined)
          await within(
            assignment.catch(() => false),
            "assignment did not settle during cleanup",
          ).catch(() => undefined);
        await database.end({ timeout: 2 });
      }
    });

    it("rejects a stale version after a concurrent archive commits first", async () => {
      const database = ownedDatabase();
      let fixture: Fixture | undefined;
      const archiveReady = deferred();
      const releaseArchive = deferred();
      let archive: Promise<"archived" | "active" | "not_found"> | undefined;
      let assignment:
        | Promise<
            | { readonly status: "fulfilled"; readonly value: boolean }
            | { readonly status: "rejected"; readonly error: unknown }
          >
        | undefined;
      try {
        fixture = await createFixture(database);
        const record = fixture;
        archive = database.begin(async (sql) => {
          await runtimeContext(sql, record);
          const result = await archiveAgentProfile(
            sql,
            record.userId,
            record.agentId,
          );
          archiveReady.resolve();
          await releaseArchive.promise;
          return result;
        });
        await within(archiveReady.promise, "archive did not reach hold point");
        assignment = database
          .begin(async (sql) => {
            await runtimeContext(sql, record);
            return setConversationOwnership(
              sql,
              record.conversationId,
              record.userId,
              "ai",
              record.agentVersionId,
            );
          })
          .then(
            (value) => ({ status: "fulfilled" as const, value }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );
        await assertPending(assignment);
        releaseArchive.resolve();
        await expect(within(archive, "archive did not complete")).resolves.toBe(
          "archived",
        );
        const assigned = await within(
          assignment,
          "stale assignment did not settle after archive",
        );
        expect(assigned.status).toBe("rejected");
        if (assigned.status === "rejected")
          expect(assigned.error).toEqual(
            expect.objectContaining({
              message: "a published WhatsApp agent is required",
            }),
          );
      } finally {
        releaseArchive.resolve();
        if (archive !== undefined)
          await within(
            archive.catch(() => "not_found" as const),
            "archive did not settle during cleanup",
          ).catch(() => undefined);
        if (assignment !== undefined)
          await within(
            assignment.catch(() => ({
              status: "rejected" as const,
              error: null,
            })),
            "assignment did not settle during cleanup",
          ).catch(() => undefined);
        await database.end({ timeout: 2 });
      }
    });

    it("lets the least-privileged messaging role assign the active default", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        await expect(
          database.begin(async (sql) => {
            await sql`SET LOCAL ROLE platform_messaging`;
            await sql`SET LOCAL statement_timeout = '5s'`;
            await sql`
              SELECT set_config('app.current_tenant', ${fixture.tenantId}, true),
                     set_config('app.current_user', ${fixture.userId}, true),
                     set_config('app.current_role', 'owner', true)
            `;
            return assignDefaultWhatsAppAi(sql, fixture.conversationId);
          }),
        ).resolves.toBe(true);
        expect(
          await database<
            { ownership_mode: string; version_id: string | null }[]
          >`
            SELECT ownership_mode,
                   ai_agent_profile_version_id AS version_id
            FROM messaging.conversations
            WHERE id=${fixture.conversationId}::uuid
          `,
        ).toEqual([
          { ownership_mode: "ai", version_id: fixture.agentVersionId },
        ]);
      } finally {
        await database.end({ timeout: 2 });
      }
    });
  },
);
