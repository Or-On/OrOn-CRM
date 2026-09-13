import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createContact, getContact, importContacts } from "./contacts.js";

const databaseUrl =
  process.env.UI_TEST_DATABASE_URL ?? process.env.CRM_TEST_DATABASE_URL;
const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";
class ExpectedRollback extends Error {}

async function isolated(
  work: (transaction: postgres.TransactionSql) => Promise<void>,
) {
  if (databaseUrl === undefined)
    throw new Error("Use the isolated UI PostgreSQL preview test runner");
  const target = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    !/^\/oron_ui_preview_[a-f0-9]+$/.test(target.pathname)
  )
    throw new Error("Only owned fictional databases are permitted");
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await expect(
      sql.begin(async (transaction) => {
        await transaction`SET LOCAL ROLE platform_web`;
        await transaction`
        SELECT set_config('app.current_tenant', ${tenantId}, true),
               set_config('app.current_user', ${userId}, true),
               set_config('app.current_role', 'owner', true)`;
        await work(transaction);
        throw new ExpectedRollback(
          "roll back prospective contact policy fixture",
        );
      }),
    ).rejects.toBeInstanceOf(ExpectedRollback);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

describe.skipIf(databaseUrl === undefined)(
  "prospective contact permissions against PostgreSQL RLS",
  () => {
    it("recovers from a real PostgreSQL row error and preserves valid surrounding rows", async () => {
      await isolated(async (sql) => {
        const result = await importContacts(sql, userId, [
          {
            name: "Fictional savepoint first",
            email: "savepoint-first@example.invalid",
          },
          {
            name: "Fictional savepoint invalid",
            email: "savepoint-invalid@example.invalid",
            company: "private\u0000invalid",
          },
          {
            name: "Fictional savepoint last",
            email: "savepoint-last@example.invalid",
          },
          {
            name: "Fictional savepoint duplicate",
            email: "savepoint-first@example.invalid",
          },
        ]);
        expect(result).toEqual({
          created: 2,
          skipped: 1,
          errors: [{ row: 3, reason: "Contact data is invalid" }],
        });
        const rows = await sql<{ email: string }[]>`
          SELECT email FROM crm.contacts WHERE email LIKE 'savepoint-%@example.invalid' ORDER BY email`;
        expect(rows.map((row) => row.email)).toEqual([
          "savepoint-first@example.invalid",
          "savepoint-last@example.invalid",
        ]);
      });
    });

    it("grants both channels only for a genuinely new manual contact", async () => {
      await isolated(async (sql) => {
        const contact = await createContact(sql, userId, {
          name: "Fictional genuinely new permission contact",
          phone: "+12025550197",
          email: "genuinely-new-permission@example.invalid",
        });
        expect(contact).toMatchObject({
          voiceConsent: "granted",
          whatsAppConsent: "granted",
          whatsAppOptedOutAt: null,
        });
        expect(contact.identities).toHaveLength(1);
        expect(contact.identities[0]?.normalizedValue).toBe("+12025550197");
      });
    });

    it.each([
      {
        state: "unknown",
        consent: "unknown",
        lifecycle: "active",
        optedOut: false,
      },
      {
        state: "revoked",
        consent: "revoked",
        lifecycle: "active",
        optedOut: false,
      },
      {
        state: "opted-out",
        consent: "granted",
        lifecycle: "active",
        optedOut: true,
      },
      {
        state: "archived",
        consent: "revoked",
        lifecycle: "archived",
        optedOut: false,
      },
    ])(
      "does not shadow a $state phone-only recipient through manual/API creation or import",
      async ({ consent, lifecycle, optedOut }) => {
        await isolated(async (sql) => {
          const optOut = optedOut ? new Date("2026-09-01T00:00:00Z") : null;
          const rows = await sql<{ id: string }[]>`
        INSERT INTO crm.contacts
          (tenant_id, created_by_user_id, name, lifecycle_status, voice_consent, whatsapp_consent, whatsapp_opted_out_at)
        VALUES (platform.current_tenant_id(), ${userId}::uuid, 'Fictional restricted phone-only contact',
                ${lifecycle}, ${consent}, ${consent}, ${optOut})
        RETURNING id`;
          const id = rows[0]?.id;
          if (!id) throw new Error("Restricted fixture insert failed");
          await sql`
        INSERT INTO crm.contact_channel_identities
          (tenant_id, contact_id, channel, normalized_value, display_value, validation_status, is_primary)
        VALUES (platform.current_tenant_id(), ${id}::uuid, 'phone', '+12025550198',
                '+12025550198', 'valid', true)`;
          const before = await getContact(sql, id);
          for (const actor of [userId, null]) {
            await expect(
              createContact(sql, actor, {
                name: "Fictional forbidden shadow",
                phone: "+12025550198",
              }),
            ).rejects.toMatchObject({ code: "23505" });
          }
          expect(
            await importContacts(sql, userId, [
              {
                name: "Fictional forbidden import shadow",
                phone: "+12025550198",
              },
            ]),
          ).toEqual({ created: 0, skipped: 1, errors: [] });
          expect(await getContact(sql, id)).toEqual(before);
          const duplicates = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM crm.contact_channel_identities
        WHERE normalized_value = '+12025550198'`;
          expect(duplicates[0]?.count).toBe(1);
          const shadows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM crm.contacts WHERE name LIKE 'Fictional forbidden%'`;
          expect(shadows[0]?.count).toBe(0);
        });
      },
    );

    it.each(["contact-field", "email-identity"])(
      "rejects case-insensitive existing email via %s",
      async (source) => {
        await isolated(async (sql) => {
          const email = "restricted-permission@example.invalid";
          const rows = await sql<{ id: string }[]>`
        INSERT INTO crm.contacts (tenant_id, created_by_user_id, name, email, lifecycle_status)
        VALUES (platform.current_tenant_id(), ${userId}::uuid, 'Fictional restricted email contact',
                ${source === "contact-field" ? email : null}, 'archived')
        RETURNING id`;
          const id = rows[0]?.id;
          if (!id) throw new Error("Restricted email fixture insert failed");
          if (source === "email-identity")
            await sql`
        INSERT INTO crm.contact_channel_identities
          (tenant_id, contact_id, channel, normalized_value, validation_status, is_primary)
        VALUES (platform.current_tenant_id(), ${id}::uuid, 'email', ${email}, 'valid', true)`;
          const before = await getContact(sql, id);
          await expect(
            createContact(sql, null, {
              name: "Fictional forbidden email shadow",
              email: email.toUpperCase(),
            }),
          ).rejects.toMatchObject({ code: "23505" });
          expect(await getContact(sql, id)).toEqual(before);
        });
      },
    );
  },
);
