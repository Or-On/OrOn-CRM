function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing synthetic fixture value");
  return value;
}
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getContact } from "./contacts.js";
import { createKnowledgeDraft } from "./knowledge.js";

const url = process.env.CRM_TEST_DATABASE_URL;
class RollbackFixture extends Error {}
describe.skipIf(!url)("real PostgreSQL two-tenant role IDOR boundaries", () => {
  it("blocks foreign reads and writes for every canonical browser role and ignores a forged manager role", async () => {
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
        db.begin(async (sql) => {
          const fixtures: {
            tenant: string;
            contact: string;
            conversation: string;
            task: string;
            calendar: string;
            job: string;
            knowledge: string;
            object: string;
            actors: Record<string, string>;
          }[] = [];
          for (let i = 0; i < 2; i++) {
            const tenant = randomUUID(),
              contact = randomUUID(),
              channel = randomUUID(),
              conversation = randomUUID(),
              task = randomUUID(),
              calendar = randomUUID(),
              job = randomUUID(),
              object = randomUUID();
            const actors: Record<string, string> = {};
            await sql`INSERT INTO public.tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Fictional security',${`security-${tenant}`},'active')`;
            for (const role of [
              "owner",
              "admin",
              "agent",
              "viewer",
              "technician",
            ]) {
              const actor = randomUUID();
              actors[role] = actor;
              await sql`INSERT INTO public.users(id,email,display_name,status) VALUES(${actor}::uuid,${`${actor}@example.invalid`},'Fictional actor','active')`;
              await sql`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${actor}::uuid,${role})`;
            }
            await sql`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${required(actors.owner)},true),set_config('app.current_role','owner',true)`;
            await sql`INSERT INTO crm.contacts(id,tenant_id,name) VALUES(${contact}::uuid,${tenant}::uuid,'Fictional private contact')`;
            await sql`INSERT INTO messaging.channels(id,tenant_id,kind,provider,status) VALUES(${channel}::uuid,${tenant}::uuid,'whatsapp','simulator','active')`;
            await sql`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,status) VALUES(${conversation}::uuid,${tenant}::uuid,${channel}::uuid,${contact}::uuid,'open')`;
            await sql`INSERT INTO crm.tasks(id,tenant_id,title) VALUES(${task}::uuid,${tenant}::uuid,'Fictional private task')`;
            await sql`INSERT INTO crm.calendar_events(id,tenant_id,title,starts_at,ends_at) VALUES(${calendar}::uuid,${tenant}::uuid,'Fictional private event',now(),now()+interval '1 hour')`;
            await sql`INSERT INTO ops.jobs(id,tenant_id,queue,job_type,payload) VALUES(${job}::uuid,${tenant}::uuid,'messaging','whatsapp.ai.reply','{}'::jsonb)`;
            await sql`INSERT INTO objects.object_metadata(id,tenant_id,created_by_user_id,owner_type,owner_id,category,content_type,byte_size,checksum,storage_backend,storage_key,status) VALUES(${object}::uuid,${tenant}::uuid,${required(actors.owner)}::uuid,'contact',${contact}::uuid,'customer_document','application/pdf',1,'fictional-checksum','local',${`fictional/${object}`},'pending')`;
            const knowledge = await createKnowledgeDraft(
              sql,
              required(actors.owner),
              {
                title: "Fictional private knowledge",
                content: "Fictional scoped information",
                facts: [
                  {
                    factKey: "fictional",
                    value: "Fictional scoped information",
                  },
                ],
                validFrom: "2020-01-01T00:00:00Z",
                validUntil: null,
              },
            );
            fixtures.push({
              tenant,
              contact,
              conversation,
              task,
              calendar,
              job,
              knowledge,
              object,
              actors,
            });
          }
          const local = required(fixtures[0]),
            foreign = required(fixtures[1]);
          await sql`SET LOCAL ROLE platform_web`;
          for (const role of [
            "owner",
            "admin",
            "agent",
            "viewer",
            "technician",
          ]) {
            await sql`SELECT set_config('app.current_tenant',${local.tenant},true),set_config('app.current_user',${required(local.actors[role])},true),set_config('app.current_role',${role},true)`;
            expect(await getContact(sql, foreign.contact)).toBeUndefined();
            if (role !== "technician")
              expect((await getContact(sql, local.contact))?.id).toBe(
                local.contact,
              );
            for (const [table, id] of [
              ["messaging.conversations", foreign.conversation],
              ["crm.tasks", foreign.task],
              ["crm.calendar_events", foreign.calendar],
              ["agents.knowledge_documents", foreign.knowledge],
              ["ops.jobs", foreign.job],
              ["objects.object_metadata", foreign.object],
            ] as const) {
              try {
                const rows = await sql.savepoint(async (nested) =>
                  nested.unsafe(`SELECT id FROM ${table} WHERE id=$1::uuid`, [
                    id,
                  ]),
                );
                expect(rows).toHaveLength(0);
              } catch (error) {
                expect(error).toMatchObject({ code: "42501" });
              }
            }
            const updated =
              await sql`UPDATE crm.contacts SET name='Forbidden replacement' WHERE id=${foreign.contact}::uuid RETURNING id`;
            expect(updated).toHaveLength(0);
          }
          await sql`SELECT set_config('app.current_user',${required(local.actors.viewer)},true),set_config('app.current_role','owner',true)`;
          expect(
            (
              await sql<
                { allowed: boolean }[]
              >`SELECT platform.canonical_actor_authorized() allowed`
            )[0]?.allowed,
          ).toBe(false);
          await expect(
            sql.savepoint(async (nested) =>
              createKnowledgeDraft(nested, required(local.actors.viewer), {
                title: "Forbidden draft",
                content: "Not authorized",
                facts: [{ factKey: "fictional", value: "Not authorized" }],
                validFrom: "2020-01-01T00:00:00Z",
                validUntil: null,
              }),
            ),
          ).rejects.toThrow();
          throw new RollbackFixture();
        }),
      ).rejects.toBeInstanceOf(RollbackFixture);
    } finally {
      await db.end({ timeout: 2 });
    }
  });
});
