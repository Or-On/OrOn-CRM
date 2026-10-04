function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing synthetic fixture value");
  return value;
}
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  createContact,
  listContacts,
  getContact,
  listContactPage,
} from "./contacts.js";
const url = process.env.CRM_TEST_DATABASE_URL;
class RollbackFixture extends Error {}
describe.skipIf(!url)("actual PostgreSQL hostile CRM parameters", () => {
  it("treats SQL payloads as data without exposing a second tenant or breaking ordinary lookup", async () => {
    const target = new URL(required(url));
    if (
      target.hostname !== "127.0.0.1" ||
      target.port !== "55480" ||
      !/^\/oron_(?:ui_preview|crm)_[a-f0-9]+$/u.test(target.pathname)
    )
      throw new Error("owned fictional database required");
    const db = postgres(required(url), { max: 1, prepare: false });
    try {
      await expect(
        db.begin(async (tx) => {
          const actor = randomUUID(),
            tenants = [randomUUID(), randomUUID()];
          await tx`INSERT INTO public.users(id,email,display_name,status) VALUES(${actor}::uuid,${`${actor}@example.invalid`},'Fictional actor','active')`;
          const ids: string[] = [];
          for (const [i, tenant] of tenants.entries()) {
            await tx`INSERT INTO public.tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Fictional injection',${`injection-${tenant}`},'active')`;
            await tx`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${actor}::uuid,'owner')`;
            await tx`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${actor},true),set_config('app.current_role','owner',true)`;
            const contact = await createContact(
              tx,
              actor,
              {
                name:
                  i === 0
                    ? "Allowed fictional contact"
                    : "FOREIGN_SECRET_SENTINEL",
              },
              { grantChannelConsent: false },
            );
            ids.push(contact.id);
          }
          await tx`SET LOCAL ROLE platform_web`;
          await tx`SELECT set_config('app.current_tenant',${required(tenants[0])},true)`;
          for (const query of [
            "' OR 1=1 --",
            "'; DROP TABLE crm.contacts; --",
            "%'; SELECT name FROM crm.contacts WHERE tenant_id <> platform.current_tenant_id(); --",
          ])
            expect(await listContacts(tx, { query })).toEqual([]);
          expect(
            (await listContacts(tx, { query: "Allowed fictional" })).map(
              (row) => row.id,
            ),
          ).toEqual([ids[0]]);
          expect(await getContact(tx, required(ids[1]))).toBeUndefined();
          await expect(
            tx.savepoint(async (sp) => getContact(sp, "' OR 1=1 --")),
          ).rejects.toMatchObject({ code: "22P02" });
          await expect(
            tx.savepoint(async (sp) =>
              listContactPage(sp, {
                cursor: { sortAt: new Date().toISOString(), id: "' OR 1=1 --" },
              }),
            ),
          ).rejects.toMatchObject({ code: "22P02" });
          expect((await listContacts(tx)).map((row) => row.id)).toEqual([
            ids[0],
          ]);
          throw new RollbackFixture();
        }),
      ).rejects.toBeInstanceOf(RollbackFixture);
    } finally {
      await db.end();
    }
  });
});
