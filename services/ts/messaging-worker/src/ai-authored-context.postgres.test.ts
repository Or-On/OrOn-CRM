function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing synthetic fixture value");
  return value;
}
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAiAuthoredContextIds } from "./ai-authored-context.js";

const sourceUrl = process.env.CRM_TEST_DATABASE_URL;
class RollbackFixture extends Error {}
describe.skipIf(!sourceUrl)("fresh PostgreSQL AI context provenance", () => {
  const databaseName = `oron_provenance_${randomUUID().replaceAll("-", "")}`;
  let maintenance: postgres.Sql | undefined;
  let db: postgres.Sql | undefined;
  beforeAll(async () => {
    const url = new URL(required(sourceUrl));
    if (url.hostname !== "127.0.0.1" || url.port !== "55480")
      throw new Error("owned fictional localhost database required");
    url.pathname = "/postgres";
    maintenance = postgres(url.toString(), { max: 1, prepare: false });
    await maintenance.unsafe(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    db = postgres(url.toString(), { max: 1, prepare: false });
    execFileSync(
      "uv",
      [
        "run",
        "--no-sync",
        "alembic",
        "-c",
        "db/alembic/alembic.ini",
        "upgrade",
        "head",
      ],
      {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        env: {
          ...process.env,
          DATABASE_URL: url.toString(),
          ENABLE_REAL_WHATSAPP: "false",
          ENABLE_REAL_TELEPHONY: "false",
        },
        stdio: "pipe",
      },
    );
  }, 120_000);
  afterAll(async () => {
    if (db) await db.end();
    if (maintenance) {
      await maintenance.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    }
  });
  it("excludes only current-tenant fresh-worker receipts after opt-in and denies forged or stale authority", async () => {
    await expect(
      required(db).begin(async (tx) => {
        const tenant = randomUUID(),
          foreign = randomUUID(),
          actor = randomUUID(),
          job = randomUUID(),
          token = randomUUID(),
          note = randomUUID(),
          task = randomUUID(),
          humanNote = randomUUID(),
          humanTask = randomUUID(),
          contact = randomUUID();
        for (const id of [tenant, foreign])
          await tx`INSERT INTO public.tenants(id,name,slug,status) VALUES(${id}::uuid,'Fictional provenance',${`provenance-${id}`},'active')`;
        await tx`INSERT INTO public.users(id,email,display_name,status) VALUES(${actor}::uuid,${`${actor}@example.invalid`},'Fictional owner','active')`;
        await tx`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${actor}::uuid,'owner')`;
        await tx`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${actor},true),set_config('app.current_role','owner',true)`;
        await tx`INSERT INTO crm.contacts(id,tenant_id,name) VALUES(${contact}::uuid,${tenant}::uuid,'Fictional provenance contact')`;
        for (const id of [note, humanNote])
          await tx`INSERT INTO crm.notes(id,tenant_id,contact_id,author_user_id,body) VALUES(${id}::uuid,${tenant}::uuid,${contact}::uuid,${actor}::uuid,'Identical content and author cannot prove AI origin')`;
        for (const id of [task, humanTask])
          await tx`INSERT INTO crm.tasks(id,tenant_id,contact_id,title) VALUES(${id}::uuid,${tenant}::uuid,${contact}::uuid,'Identical task content cannot prove origin')`;
        await tx`INSERT INTO ops.jobs(id,tenant_id,queue,job_type,payload,status,claim_token,lease_expires_at,locked_by,locked_at) VALUES(${job}::uuid,${tenant}::uuid,'messaging','whatsapp.ai.reply','{}'::jsonb,'running',${token}::uuid,clock_timestamp()+interval '5 minutes','fictional-worker',clock_timestamp())`;
        await tx`SET LOCAL ROLE platform_web`;
        await expect(
          tx.savepoint(async (sp) => {
            await sp`INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,metadata) VALUES(${tenant}::uuid,${actor}::uuid,'conversation.ai_handoff_ticket','handoff',${sp.json({ aiContextProvenance: "worker_verified_v1", taskId: task })})`;
          }),
        ).rejects.toMatchObject({ code: "42501" });
        await tx`INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,metadata) VALUES(${tenant}::uuid,${actor}::uuid,'conversation.ai_handoff_ticket','handoff',${tx.json({ taskId: humanTask, noteId: humanNote })})`;
        await tx`SET LOCAL ROLE platform_messaging`;
        const receipt = await tx<
          { id: string; metadata: Record<string, unknown> }[]
        >`INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,metadata) VALUES(${tenant}::uuid,${actor}::uuid,'conversation.ai_handoff_ticket','handoff',${tx.json({ taskId: task, noteId: note, sourceJobId: job, sourceClaimToken: token })}) RETURNING id,metadata`;
        expect(required(receipt[0]).metadata.aiContextProvenance).toBe(
          "worker_verified_v1",
        );
        expect(required(receipt[0]).metadata).not.toHaveProperty(
          "sourceClaimToken",
        );
        expect(
          await loadAiAuthoredContextIds(tx, tenant, {
            noteIds: [note, humanNote],
            taskIds: [task, humanTask],
          }),
        ).toEqual({
          noteIds: [],
          taskIds: [],
        });
        await tx`RESET ROLE`;
        await tx`INSERT INTO platform.tenant_remediation_flags(tenant_id,flag_key,enabled) VALUES(${tenant}::uuid,'exclude_ai_memory',true)`;
        await tx`SET LOCAL ROLE platform_messaging`;
        expect(
          await loadAiAuthoredContextIds(tx, tenant, {
            noteIds: [note, humanNote],
            taskIds: [task, humanTask],
          }),
        ).toEqual({
          noteIds: [note],
          taskIds: [task],
        });
        await expect(
          loadAiAuthoredContextIds(tx, foreign, {
            noteIds: [note],
            taskIds: [task],
          }),
        ).rejects.toThrow("tenant mismatch");
        await expect(
          loadAiAuthoredContextIds(tx, tenant, {
            noteIds: Array.from({ length: 65 }, () => randomUUID()),
            taskIds: [],
          }),
        ).rejects.toThrow("candidate limit exceeded");
        await tx`SELECT set_config('app.current_tenant',${foreign},true)`;
        expect(
          await loadAiAuthoredContextIds(tx, foreign, {
            noteIds: [note],
            taskIds: [task],
          }),
        ).toEqual({ noteIds: [], taskIds: [] });
        await tx`SELECT set_config('app.current_tenant',${tenant},true)`;
        await expect(
          tx.savepoint(async (sp) => {
            await sp`INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,metadata) VALUES(${tenant}::uuid,${actor}::uuid,'conversation.ai_model_failure','job',${sp.json({ taskId: randomUUID(), sourceJobId: job, sourceClaimToken: randomUUID() })})`;
          }),
        ).rejects.toMatchObject({ code: "42501" });
        await tx`RESET ROLE`;
        await tx`UPDATE ops.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${job}::uuid`;
        await tx`SET LOCAL ROLE platform_messaging`;
        await expect(
          tx.savepoint(async (sp) => {
            await sp`INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,metadata) VALUES(${tenant}::uuid,${actor}::uuid,'conversation.ai_model_failure','job',${sp.json({ taskId: randomUUID(), sourceJobId: job, sourceClaimToken: token })})`;
          }),
        ).rejects.toMatchObject({ code: "42501" });
        await tx`RESET ROLE`;
        await expect(
          tx.savepoint(async (sp) => {
            await sp`UPDATE audit.records SET metadata='{}'::jsonb WHERE id=${required(receipt[0]).id}::uuid`;
          }),
        ).rejects.toMatchObject({ code: "42501" });
        throw new RollbackFixture();
      }),
    ).rejects.toBeInstanceOf(RollbackFixture);
  });
});
