function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing synthetic fixture value");
  return value;
}
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const url = process.env.CRM_TEST_DATABASE_URL;
class RollbackFixture extends Error {}
describe.skipIf(!url)("AI context receipt trust baseline", () => {
  it("documents that browser audit action and metadata are not server-authored proof", async () => {
    const target = new URL(required(url));
    if (
      target.hostname !== "127.0.0.1" ||
      target.port !== "55480" ||
      !/^\/oron_(?:ui_preview|crm)_[a-f0-9]+$/u.test(target.pathname)
    )
      throw new Error("owned fictional local database required");
    const db = postgres(required(url), { max: 1, prepare: false });
    try {
      await expect(
        db.begin(async (tx) => {
          const tenant = randomUUID(),
            actor = randomUUID(),
            fakeTask = randomUUID(),
            fakeNote = randomUUID();
          await tx`INSERT INTO public.tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Fictional provenance',${`provenance-${tenant}`},'active')`;
          await tx`INSERT INTO public.users(id,email,display_name,status) VALUES(${actor}::uuid,${`${actor}@example.invalid`},'Fictional owner','active')`;
          await tx`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${actor}::uuid,'owner')`;
          await tx`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${actor},true),set_config('app.current_role','owner',true)`;
          await tx`SET LOCAL ROLE platform_web`;
          const result = await tx<
            { id: string }[]
          >`INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES(${tenant}::uuid,${actor}::uuid,'conversation.ai_handoff_ticket','handoff',${randomUUID()}::uuid,${tx.json({ taskId: fakeTask, noteId: fakeNote })}) RETURNING id`;
          expect(result).toHaveLength(1);
          const forged = await tx<
            { metadata: unknown }[]
          >`SELECT metadata FROM audit.records WHERE id=${required(result[0]).id}::uuid`;
          expect(required(forged[0]).metadata).toEqual({
            taskId: fakeTask,
            noteId: fakeNote,
          });
          throw new RollbackFixture();
        }),
      ).rejects.toBeInstanceOf(RollbackFixture);
    } finally {
      await db.end();
    }
  });
});
