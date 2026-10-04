import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApiKey } from "@or-on/crm";
import { GET, POST } from "../src/app/api/v1/contacts/route";
const sourceUrl = process.env.CRM_TEST_DATABASE_URL;
describe.skipIf(!sourceUrl)(
  "actual public CRM handler with isolated PostgreSQL",
  () => {
    const name = `oron_public_api_${randomUUID().replaceAll("-", "")}`,
      pepper = "fictional-only-pepper-01234567890123456789";
    let maintenance: postgres.Sql | undefined,
      db: postgres.Sql | undefined,
      token: string;
    const tenants = [randomUUID(), randomUUID()] as const;
    const foreignName = `FOREIGN_SECRET_${randomUUID()}`;
    beforeAll(async () => {
      if (!sourceUrl) throw new Error("explicit synthetic database required");
      const url = new URL(sourceUrl);
      if (url.hostname !== "127.0.0.1" || url.port !== "55480")
        throw new Error("owned localhost database required");
      url.pathname = "/postgres";
      maintenance = postgres(url.toString(), { max: 1, prepare: false });
      await maintenance.unsafe(`CREATE DATABASE "${name}"`);
      url.pathname = `/${name}`;
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
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          env: {
            ...process.env,
            DATABASE_URL: url.toString(),
            ENABLE_REAL_WHATSAPP: "false",
            ENABLE_REAL_TELEPHONY: "false",
          },
          stdio: "pipe",
        },
      );
      await db.begin(async (tx) => {
        const actor = randomUUID();
        await tx`INSERT INTO public.users(id,email,display_name,status) VALUES(${actor}::uuid,${`${actor}@example.invalid`},'Fictional owner','active')`;
        for (const tenant of tenants) {
          await tx`INSERT INTO public.tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Fictional API',${`api-${tenant}`},'active')`;
          await tx`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${actor}::uuid,'owner')`;
        }
        await tx`SELECT set_config('app.current_tenant',${tenants[0]},true),set_config('app.current_user',${actor},true),set_config('app.current_role','owner',true)`;
        token = (
          await createApiKey(tx, actor, pepper, "Fictional test key", [
            "crm:read",
            "crm:write",
          ])
        ).token;
        await tx`SELECT set_config('app.current_tenant',${tenants[1]},true)`;
        await tx`INSERT INTO crm.contacts(tenant_id,name) VALUES(${tenants[1]}::uuid,${foreignName})`;
      });
      url.searchParams.set("options", "-c role=platform_web");
      vi.stubEnv("DATABASE_URL", url.toString());
      vi.stubEnv("AUTH_TOKEN_PEPPER", pepper);
    }, 120000);
    afterAll(async () => {
      vi.unstubAllEnvs();
      if (db) await db.end();
      if (maintenance) {
        await maintenance.unsafe(`DROP DATABASE "${name}" WITH(FORCE)`);
        await maintenance.end();
      }
    });
    const request = (body: string, bearer = token) =>
      new Request("http://localhost/api/v1/contacts", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        body,
      });
    it("denies invalid credentials before consuming body and bounds authenticated JSON", async () => {
      const invalid = request("{", "oron_" + "invalid".repeat(8));
      expect((await POST(invalid)).status).toBe(401);
      expect(invalid.bodyUsed).toBe(false);
      expect(
        (await POST(request(JSON.stringify({ name: "x".repeat(16384) }))))
          .status,
      ).toBe(413);
      expect((await POST(request("{"))).status).toBe(400);
      expect((await POST(request(JSON.stringify({ name: " " })))).status).toBe(
        400,
      );
    });
    it("preserves allowed creation and parameterizes hostile names and search without tenant switching", async () => {
      const malicious = "'; DROP TABLE crm.contacts; --";
      const created = await POST(
        request(
          JSON.stringify({
            name: malicious,
            tenantId: tenants[1],
            role: "owner",
          }),
        ),
      );
      expect(created.status).toBe(201);
      const response = await GET(
        new Request(
          "http://localhost/api/v1/contacts?q=" + encodeURIComponent(malicious),
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { contacts: { name: string }[] };
      expect(body.contacts.map((row: { name: string }) => row.name)).toEqual([
        malicious,
      ]);
      const foreign = await GET(
        new Request(
          "http://localhost/api/v1/contacts?q=" +
            encodeURIComponent(foreignName),
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );
      expect(await foreign.json()).toEqual({ contacts: [] });
      const ordinary = await POST(
        request(JSON.stringify({ name: "Allowed fictional contact" })),
      );
      expect(ordinary.status).toBe(201);
    });
  },
);
