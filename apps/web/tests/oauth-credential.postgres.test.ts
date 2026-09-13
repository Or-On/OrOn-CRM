import { createHash } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { saveOAuthCredential } from "../src/features/email";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "OAuth credential concurrency (explicit isolated PostgreSQL only)",
  () => {
    it("serializes first saves for the same mailbox and keeps another mailbox separate", async () => {
      if (!databaseUrl) throw new Error("TEST_DATABASE_URL required");
      const admin = postgres(databaseUrl, { max: 1 });
      const connections = Array.from({ length: 6 }, () =>
        postgres(databaseUrl, { max: 1 }),
      );
      const tenantId = crypto.randomUUID();
      vi.stubEnv(
        "CREDENTIAL_ENCRYPTION_KEY",
        Buffer.alloc(32, 7).toString("base64"),
      );
      try {
        await admin`INSERT INTO tenants(id,name,slug) VALUES(${tenantId}::uuid,'OAuth concurrency',${`oauth-${tenantId}`})`;
        const ids = await Promise.all(
          connections.map((connection, index) =>
            connection.begin(async (sql) => {
              await sql`SET LOCAL ROLE platform_web`;
              await sql`SELECT set_config('app.current_tenant',${tenantId},true)`;
              return saveOAuthCredential(
                sql,
                "google",
                { access_token: `fictional-${String(index)}` },
                "token",
                index < 5 ? "mailbox-one" : "mailbox-two",
              );
            }),
          ),
        );
        expect(new Set(ids.slice(0, 5)).size).toBe(1);
        expect(ids[5]).not.toBe(ids[0]);
        const kind = `email_oauth_token_google_${createHash("sha256").update("mailbox-one").digest("hex")}`;
        const rows =
          await admin`SELECT count(*)::integer AS count FROM platform.credential_records WHERE tenant_id=${tenantId}::uuid AND kind=${kind}`;
        expect(rows[0]?.count).toBe(1);
      } finally {
        for (const connection of connections) await connection.end();
        await admin`DELETE FROM platform.credential_records WHERE tenant_id=${tenantId}::uuid`;
        await admin`DELETE FROM tenants WHERE id=${tenantId}::uuid`;
        await admin.end();
        vi.unstubAllEnvs();
      }
    });
  },
);
