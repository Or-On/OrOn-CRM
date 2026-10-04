import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("required synthetic fixture value missing");
  return value;
}

const url = process.env.CRM_TEST_DATABASE_URL;
class RollbackFixture extends Error {}
describe.skipIf(!url)("remediation rollout authorization", () => {
  it("allows stored admin/owner only, ignores forged role, rejects other tenants and inactive users", async () => {
    const target = new URL(required(url));
    if (
      target.hostname !== "127.0.0.1" ||
      target.port !== "55480" ||
      !/^\/oron_(?:crm|ui_preview|knowledge)_[a-f0-9]+$/u.test(target.pathname)
    )
      throw new Error("independent synthetic memory fixture required");
    const db = postgres(required(url), { max: 1, prepare: false });
    try {
      await expect(
        db.begin(async (sql) => {
          const tenants = [randomUUID(), randomUUID()] as const;
          const actors = {
            owner: randomUUID(),
            admin: randomUUID(),
            viewer: randomUUID(),
            inactive: randomUUID(),
          };
          for (const tenant of tenants)
            await sql`INSERT INTO public.tenants(id,name,slug,status)
          VALUES(${tenant}::uuid,'Fictional rollout',${`flags-${tenant}`},'active')`;
          for (const [role, user] of Object.entries(actors)) {
            await sql`INSERT INTO public.users(id,email,display_name,status)
            VALUES(${user}::uuid,${`${user}@example.invalid`},'Fictional rollout',${role === "inactive" ? "inactive" : "active"})`;
            await sql`INSERT INTO public.memberships(tenant_id,user_id,role)
            VALUES(${tenants[0]}::uuid,${user}::uuid,${role === "inactive" ? "admin" : role})`;
          }
          await sql`SET LOCAL ROLE platform_web`;
          for (const actor of [actors.owner, actors.admin]) {
            await sql`SELECT set_config('app.current_tenant',${required(tenants[0])},true),
            set_config('app.current_user',${actor},true),set_config('app.current_role','viewer',true)`;
            expect(
              (
                await sql<
                  { enabled: boolean }[]
                >`SELECT platform.set_tenant_remediation_flag('session_memory',true) enabled`
              )[0]?.enabled,
            ).toBe(true);
            expect(
              (
                await sql<{ enabled: boolean }[]>`
              SELECT platform.set_tenant_remediation_flag('audio_transcription',true) enabled
            `
              )[0]?.enabled,
            ).toBe(true);
          }
          for (const actor of [actors.viewer, actors.inactive]) {
            await sql`SELECT set_config('app.current_user',${actor},true),set_config('app.current_role','owner',true)`;
            await expect(
              sql.savepoint(async (nested) => {
                await nested`SELECT platform.set_tenant_remediation_flag('session_memory',false)`;
              }),
            ).rejects.toMatchObject({ code: "42501" });
          }
          await sql`SELECT set_config('app.current_tenant',${required(tenants[1])},true),set_config('app.current_user',${actors.owner},true)`;
          await expect(
            sql.savepoint(async (nested) => {
              await nested`SELECT platform.set_tenant_remediation_flag('session_memory',true)`;
            }),
          ).rejects.toMatchObject({ code: "42501" });
          expect(
            await sql`SELECT * FROM platform.tenant_remediation_flags`,
          ).toHaveLength(0);
          throw new RollbackFixture();
        }),
      ).rejects.toBeInstanceOf(RollbackFixture);
    } finally {
      await db.end();
    }
  });
});
