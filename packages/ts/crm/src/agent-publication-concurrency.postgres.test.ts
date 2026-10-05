import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  createAgentProfileDraft,
  createAgentProfileRevision,
  publishAgentProfile,
} from "./cross-channel.js";

const databaseUrl = process.env.CRM_TEST_DATABASE_URL;
interface Fixture {
  tenantId: string;
  userId: string;
  profileId: string;
  versionId: string;
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
  return postgres(databaseUrl, { max: 4, prepare: false });
}

async function context(sql: postgres.TransactionSql, fixture: Fixture) {
  await sql`SET LOCAL ROLE platform_web`;
  await sql`SET LOCAL lock_timeout = '4s'`;
  await sql`SET LOCAL statement_timeout = '5s'`;
  await sql`SELECT set_config('app.current_tenant',${fixture.tenantId},true),
    set_config('app.current_user',${fixture.userId},true),
    set_config('app.current_role','owner',true)`;
}

async function fixture(database: postgres.Sql): Promise<Fixture> {
  return database.begin(async (sql) => {
    const record = {
      tenantId: randomUUID(),
      userId: randomUUID(),
      profileId: "",
      versionId: "",
    };
    await sql`INSERT INTO tenants(id,name,slug,status)
      VALUES(${record.tenantId}::uuid,'Fictional publication race',${`publication-${record.tenantId}`},'active')`;
    await sql`INSERT INTO users(id,email,display_name,status)
      VALUES(${record.userId}::uuid,${`${record.userId}@example.invalid`},'Fictional owner','active')`;
    await sql`INSERT INTO memberships(tenant_id,user_id,role)
      VALUES(${record.tenantId}::uuid,${record.userId}::uuid,'owner')`;
    await sql`INSERT INTO crm.tenant_settings(tenant_id) VALUES(${record.tenantId}::uuid)`;
    await context(sql, record);
    record.profileId = await createAgentProfileDraft(sql, record.userId, {
      name: "Fictional publication candidate",
      systemPrompt: "Answer fictional questions.",
      channels: ["whatsapp"],
    });
    const [version] = await sql<
      { id: string }[]
    >`SELECT id FROM agents.agent_profile_versions
      WHERE agent_profile_id=${record.profileId}::uuid`;
    if (!version) throw new Error("fixture version missing");
    record.versionId = version.id;
    return record;
  });
}

async function revision(sql: postgres.TransactionSql, record: Fixture) {
  const created = await createAgentProfileRevision(
    sql,
    record.userId,
    record.profileId,
    {
      baseVersionId: record.versionId,
      systemPrompt: "New fictional instructions.",
      channels: ["whatsapp"],
    },
  );
  if (!created) throw new Error("fixture revision missing");
  return created;
}

async function assertUnpublished(database: postgres.Sql, record: Fixture) {
  expect(
    await database`SELECT id FROM agents.agent_profile_versions
    WHERE agent_profile_id=${record.profileId}::uuid AND published_at IS NOT NULL`,
  ).toHaveLength(0);
  expect(
    await database`SELECT id FROM audit.records
    WHERE target_id=${record.profileId}::uuid AND action='agent_profile.published'`,
  ).toHaveLength(0);
  const [settings] = await database<
    { whatsapp_ai_agent_profile_id: string | null }[]
  >`
    SELECT whatsapp_ai_agent_profile_id FROM crm.tenant_settings WHERE tenant_id=${record.tenantId}::uuid`;
  expect(settings?.whatsapp_ai_agent_profile_id).toBeNull();
}

describe.skipIf(databaseUrl === undefined)(
  "reviewed agent publication under actual RLS",
  () => {
    it.each([false, true])(
      "publishes the reviewed latest draft (expected version supplied: %s)",
      async (pinned) => {
        const database = ownedDatabase();
        try {
          const record = await fixture(database);
          await expect(
            database.begin(async (sql) => {
              await context(sql, record);
              return publishAgentProfile(
                sql,
                record.userId,
                record.profileId,
                pinned ? record.versionId : undefined,
              );
            }),
          ).resolves.toBe(true);
          expect(
            await database<
              { id: string }[]
            >`SELECT id FROM agents.agent_profile_versions
        WHERE agent_profile_id=${record.profileId}::uuid AND published_at IS NOT NULL`,
          ).toEqual([{ id: record.versionId }]);
        } finally {
          await database.end({ timeout: 2 });
        }
      },
    );

    it("rejects an already superseded reviewed draft without publication, audit or default changes", async () => {
      const database = ownedDatabase();
      try {
        const record = await fixture(database);
        await database.begin(async (sql) => {
          await context(sql, record);
          await revision(sql, record);
        });
        await expect(
          database.begin(async (sql) => {
            await context(sql, record);
            return publishAgentProfile(
              sql,
              record.userId,
              record.profileId,
              record.versionId,
            );
          }),
        ).rejects.toMatchObject({ name: "AgentProfileVersionConflictError" });
        await assertUnpublished(database, record);
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("rejects an expected version from another tenant without disclosing or publishing either profile", async () => {
      const database = ownedDatabase();
      try {
        const record = await fixture(database),
          foreign = await fixture(database);
        await expect(
          database.begin(async (sql) => {
            await context(sql, record);
            return publishAgentProfile(
              sql,
              record.userId,
              record.profileId,
              foreign.versionId,
            );
          }),
        ).rejects.toMatchObject({ name: "AgentProfileVersionConflictError" });
        await assertUnpublished(database, record);
        await assertUnpublished(database, foreign);
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("rechecks the expected version after a concurrent editor releases the profile lock", async () => {
      const database = ownedDatabase();
      let releaseEdit!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseEdit = resolve;
      });
      let editor: Promise<unknown> | undefined,
        publisher: Promise<unknown> | undefined;
      try {
        const record = await fixture(database);
        let editReady!: (version: string) => void;
        const ready = new Promise<string>((resolve) => {
          editReady = resolve;
        });
        editor = database.begin(async (sql) => {
          await context(sql, record);
          const created = await revision(sql, record);
          editReady(created.versionId);
          await release;
        });
        const newVersion = await ready;
        let publisherReady!: (pid: number) => void;
        const started = new Promise<number>((resolve) => {
          publisherReady = resolve;
        });
        publisher = database
          .begin(async (sql) => {
            await context(sql, record);
            const [backend] = await sql<
              { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`;
            if (!backend) throw new Error("publisher backend missing");
            publisherReady(backend.pid);
            return publishAgentProfile(
              sql,
              record.userId,
              record.profileId,
              record.versionId,
            );
          })
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
        const pid = await started;
        // Observe an actual database lock wait, rather than infer serialization
        // from how quickly the JavaScript promises happen to settle.
        await expect
          .poll(
            async () => {
              const [row] = await database<{ blocked: boolean }[]>`
          SELECT cardinality(pg_blocking_pids(${pid})) > 0 AS blocked`;
              return row?.blocked;
            },
            { timeout: 2_000, interval: 20 },
          )
          .toBe(true);
        releaseEdit();
        await editor;
        expect(await publisher).toMatchObject({
          error: { name: "AgentProfileVersionConflictError" },
        });
        await assertUnpublished(database, record);
        await expect(
          database.begin(async (sql) => {
            await context(sql, record);
            return publishAgentProfile(
              sql,
              record.userId,
              record.profileId,
              newVersion,
            );
          }),
        ).resolves.toBe(true);
        expect(
          await database<
            { id: string }[]
          >`SELECT id FROM agents.agent_profile_versions
        WHERE agent_profile_id=${record.profileId}::uuid AND published_at IS NOT NULL`,
        ).toEqual([{ id: newVersion }]);
      } finally {
        releaseEdit();
        await Promise.allSettled([editor, publisher]);
        await database.end({ timeout: 2 });
      }
    });
  },
);
