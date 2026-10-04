import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { acceptWhatsAppWebhook } from "./webhook-store.js";

const databaseUrl = process.env.CRM_TEST_DATABASE_URL;
const secret = "fictional-whatsapp-batch-secret";
function signed(accounts: readonly string[]) {
  const body = Buffer.from(
    JSON.stringify({
      entry: accounts.map((account, i) => ({
        changes: [
          {
            value: {
              metadata: { phone_number_id: account },
              messages: [
                {
                  id: `test-${account}-${String(i)}`,
                  from: "972500000001",
                  type: "text",
                  text: { body: "Fictional test" },
                },
              ],
              statuses: [
                {
                  id: `status-${account}-${String(i)}`,
                  status: "delivered",
                  timestamp: "1700000000",
                },
              ],
            },
          },
        ],
      })),
    }),
  );
  return {
    body,
    signature:
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
  };
}
describe.skipIf(!databaseUrl)(
  "signed shared-account webhook transactions",
  () => {
    it("keeps valid messages/statuses around unknown accounts and retries idempotently", async () => {
      if (!databaseUrl) throw new Error("owned fixture required");
      const target = new URL(databaseUrl);
      if (
        target.hostname !== "127.0.0.1" ||
        !/^\/oron_ui_preview_[a-f0-9]+$/u.test(target.pathname)
      )
        throw new Error("owned localhost fixture required");
      const sql = postgres(databaseUrl, { max: 1, prepare: false });
      const tenant = randomUUID(),
        account = `qa-${randomUUID()}`;
      try {
        await sql`INSERT INTO tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Fictional webhook tenant',${account},'active')`;
        await sql`INSERT INTO messaging.channels(tenant_id,kind,provider,provider_account_id,display_address,status) VALUES(${tenant}::uuid,'whatsapp','meta',${account},'Fictional QA','active')`;
        const input = signed([account, `unknown-${randomUUID()}`, account]);
        const accepted = await acceptWhatsAppWebhook(
          databaseUrl,
          input.body,
          input.signature,
          secret,
        );
        expect(accepted.envelopes).toBe(4);
        expect(accepted.skippedUnknownAccounts).toBe(2);
        const retry = await acceptWhatsAppWebhook(
          databaseUrl,
          input.body,
          input.signature,
          secret,
        );
        expect(retry.eventIds).toEqual(accepted.eventIds);
        const count = await sql<
          { count: number }[]
        >`SELECT count(*)::int count FROM ops.inbound_events WHERE tenant_id=${tenant}::uuid`;
        expect(count[0]?.count).toBe(4);
        const unknown = signed([`unknown-${randomUUID()}`]);
        expect(
          await acceptWhatsAppWebhook(
            databaseUrl,
            unknown.body,
            unknown.signature,
            secret,
          ),
        ).toMatchObject({ envelopes: 0, skippedUnknownAccounts: 2 });
        // A tenant-scoped synthetic fault proves unrelated database errors
        // remain retryable failures instead of being silently acknowledged.
        const guard = `qa_webhook_guard_${tenant.replaceAll("-", "")}`;
        try {
          for (const code of ["23505", "22023"]) {
            await sql.unsafe(
              `CREATE OR REPLACE FUNCTION public.${guard}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic database failure' USING ERRCODE='${code}'; END $$`,
            );
            if (code === "23505")
              await sql.unsafe(
                `CREATE TRIGGER ${guard} BEFORE INSERT ON ops.inbound_events FOR EACH ROW WHEN (NEW.tenant_id='${tenant}'::uuid) EXECUTE FUNCTION public.${guard}()`,
              );
            const fault = signed([account]);
            await expect(
              acceptWhatsAppWebhook(
                databaseUrl,
                fault.body,
                fault.signature,
                secret,
              ),
            ).rejects.toMatchObject({
              code,
              message: "synthetic database failure",
            });
          }
        } finally {
          await sql.unsafe(
            `DROP TRIGGER IF EXISTS ${guard} ON ops.inbound_events`,
          );
          await sql.unsafe(`DROP FUNCTION IF EXISTS public.${guard}()`);
        }
        await sql`UPDATE messaging.channels SET status='disabled' WHERE tenant_id=${tenant}::uuid`;
        const inactive = signed([account]);
        expect(
          await acceptWhatsAppWebhook(
            databaseUrl,
            inactive.body,
            inactive.signature,
            secret,
          ),
        ).toMatchObject({ envelopes: 0, skippedUnknownAccounts: 2 });
      } finally {
        await sql`DELETE FROM ops.inbound_events WHERE tenant_id=${tenant}::uuid`;
        await sql`DELETE FROM messaging.channels WHERE tenant_id=${tenant}::uuid`;
        await sql`DELETE FROM tenants WHERE id=${tenant}::uuid`;
        await sql.end();
      }
    });
  },
);
