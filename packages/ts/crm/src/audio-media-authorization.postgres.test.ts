import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getMessageMediaObjectMetadata } from "./messaging.js";

function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("required synthetic fixture value missing");
  return value;
}

const url = process.env.CRM_TEST_DATABASE_URL;
class RollbackFixture extends Error {}
describe.skipIf(!url)("authorized private inbox audio", () => {
  it("keeps tenant/role/object/MIME/soft-deletion boundaries while admitting validated ogg/wav", async () => {
    const target = new URL(required(url));
    if (
      target.hostname !== "127.0.0.1" ||
      target.port !== "55480" ||
      !/^\/oron_(?:crm|ui_preview)_[a-f0-9]+$/u.test(target.pathname)
    )
      throw new Error("owned synthetic audio database required");
    const db = postgres(required(url), { max: 1, prepare: false });
    try {
      await expect(
        db.begin(async (sql) => {
          const tenant = randomUUID(),
            foreign = randomUUID(),
            actor = randomUUID(),
            contact = randomUUID(),
            channel = randomUUID(),
            conversation = randomUUID();
          for (const id of [tenant, foreign])
            await sql`INSERT INTO public.tenants(id,name,slug,status)
      VALUES(${id}::uuid,'Fictional private audio',${id},'active')`;
          await sql`INSERT INTO public.users(id,email,display_name,status)
      VALUES(${actor}::uuid,${`${actor}@example.invalid`},'Fictional audio operator','active')`;
          await sql`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${actor}::uuid,'owner')`;
          await sql`INSERT INTO crm.contacts(id,tenant_id,name) VALUES(${contact}::uuid,${tenant}::uuid,'Fictional voice sender')`;
          await sql`INSERT INTO messaging.channels(id,tenant_id,kind,provider,display_address,provider_account_id,status)
      VALUES(${channel}::uuid,${tenant}::uuid,'whatsapp','meta','Fictional private audio',${channel},'active')`;
          await sql`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,status)
      VALUES(${conversation}::uuid,${tenant}::uuid,${channel}::uuid,${contact}::uuid,'open')`;
          const fixtures: { message: string; object: string; mime: string }[] =
            [];
          for (const mime of ["audio/ogg", "audio/wav"]) {
            const message = randomUUID(),
              object = randomUUID();
            await sql`INSERT INTO objects.object_metadata(id,tenant_id,owner_type,owner_id,category,content_type,byte_size,checksum,storage_backend,storage_key,status)
        VALUES(${object}::uuid,${tenant}::uuid,'message',${message}::uuid,'whatsapp_customer_audio',${mime},100,${"a".repeat(64)},'local',${`${tenant}/fixture/${message}`},'available')`;
            await sql`INSERT INTO messaging.messages(id,tenant_id,conversation_id,direction,sender_type,content_type,object_id,provider,status)
        VALUES(${message}::uuid,${tenant}::uuid,${conversation}::uuid,'inbound','contact','audio',${object}::uuid,'meta','received')`;
            fixtures.push({ message, object, mime });
          }
          await sql`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${actor},true),set_config('app.current_role','owner',true)`;
          await sql`SET LOCAL ROLE platform_web`;
          for (const fixture of fixtures)
            expect(
              (await getMessageMediaObjectMetadata(sql, fixture.message))
                ?.contentType,
            ).toBe(fixture.mime);
          await sql`SELECT set_config('app.current_tenant',${foreign},true)`;
          expect(
            await getMessageMediaObjectMetadata(
              sql,
              required(fixtures[0]).message,
            ),
          ).toBeUndefined();
          await sql`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_role','admin',true)`;
          expect(
            await getMessageMediaObjectMetadata(
              sql,
              required(fixtures[0]).message,
            ),
          ).toBeUndefined();
          await sql`SELECT set_config('app.current_role','owner',true)`;
          await sql`RESET ROLE`;
          await sql`UPDATE objects.object_metadata SET owner_id=${randomUUID()}::uuid WHERE id=${required(fixtures[0]).object}::uuid`;
          await sql`UPDATE objects.object_metadata SET content_type='application/pdf' WHERE id=${required(fixtures[1]).object}::uuid`;
          await sql`SET LOCAL ROLE platform_web`;
          for (const fixture of fixtures)
            expect(
              await getMessageMediaObjectMetadata(sql, fixture.message),
            ).toBeUndefined();
          await sql`RESET ROLE`;
          await sql`UPDATE objects.object_metadata SET content_type='audio/wav',deleted_at=clock_timestamp() WHERE id=${required(fixtures[1]).object}::uuid`;
          await sql`SET LOCAL ROLE platform_web`;
          expect(
            await getMessageMediaObjectMetadata(
              sql,
              required(fixtures[1]).message,
            ),
          ).toBeUndefined();
          await sql`RESET ROLE`;
          await sql`UPDATE objects.object_metadata SET deleted_at=NULL WHERE id=${required(fixtures[1]).object}::uuid`;
          await sql`UPDATE messaging.conversations SET removed_from_inbox_at=clock_timestamp() WHERE id=${conversation}::uuid`;
          await sql`SET LOCAL ROLE platform_web`;
          expect(
            await getMessageMediaObjectMetadata(
              sql,
              required(fixtures[1]).message,
            ),
          ).toBeUndefined();
          throw new RollbackFixture();
        }),
      ).rejects.toBeInstanceOf(RollbackFixture);
    } finally {
      await db.end();
    }
  });
});
