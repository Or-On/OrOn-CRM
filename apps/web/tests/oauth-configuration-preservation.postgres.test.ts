import { randomUUID } from "node:crypto";
import postgres, { type TransactionSql } from "postgres";
import { withTenantTransaction } from "@or-on/auth";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

interface FixtureSession {
  userId: string;
  tenant: { tenantId: string };
}
interface EnvelopeRow {
  id: string;
  ciphertext: Buffer;
  nonce: Buffer;
  key_version: string;
  rotated_at: Date | null;
}
const state = vi.hoisted(() => ({
  tenantId: "",
  scope: undefined as
    | undefined
    | ((
        operation: (
          sql: TransactionSql,
          session: FixtureSession,
        ) => Promise<unknown>,
      ) => Promise<unknown>),
}));
vi.mock("../src/features/auth", () => {
  const scoped = (
    _permission: string,
    operation: (
      sql: TransactionSql,
      session: FixtureSession,
    ) => Promise<unknown>,
  ) => {
    if (!state.scope) throw new Error("fixture unavailable");
    return state.scope(operation);
  };
  return {
    withCurrentTenant: scoped,
    withFreshCurrentTenant: scoped,
    jsonObject: (request: Request) =>
      request.json() as Promise<Record<string, unknown>>,
    requestId: () => "fictional-credential-preservation",
  };
});
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: () => Promise.resolve(),
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: error instanceof TypeError ? 400 : 403 },
    ),
}));
import { GET, POST } from "../src/app/api/email/oauth/configuration/route";
import { PATCH as saveSettings } from "../src/app/api/settings/route";
import { GET as startOAuth } from "../src/app/api/email/oauth/[provider]/start/route";
import {
  readOAuthCredential,
  type OAuthClientConfiguration,
} from "../src/features/email";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "credential preservation through real API handlers and isolated PostgreSQL",
  () => {
    const tenantA = randomUUID(),
      tenantB = randomUUID(),
      userId = randomUUID();
    let admin: ReturnType<typeof postgres>;
    let runtimeUrl: string;
    const fetcher = vi.fn(() => {
      throw new Error("External provider request forbidden in fixture");
    });
    beforeAll(async () => {
      const parsed = new URL(databaseUrl ?? "");
      if (
        parsed.hostname !== "127.0.0.1" ||
        !/^\/oron_ui_preview_[a-f0-9]{32}$/u.test(parsed.pathname)
      )
        throw new Error("owned local fixture required");
      admin = postgres(databaseUrl ?? "", { max: 1 });
      parsed.searchParams.set("options", "-c role=platform_web");
      runtimeUrl = parsed.toString();
      vi.stubEnv(
        "CREDENTIAL_ENCRYPTION_KEY",
        Buffer.alloc(32, 19).toString("base64"),
      );
      vi.stubGlobal("fetch", fetcher);
      await admin`INSERT INTO users(id,email,status) VALUES(${userId}::uuid,${`${userId}@example.invalid`},'active')`;
      for (const tenant of [tenantA, tenantB]) {
        await admin`INSERT INTO tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Fictional credential preservation',${tenant},'active')`;
        await admin`INSERT INTO memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${userId}::uuid,'owner')`;
      }
      state.scope = (operation) =>
        withTenantTransaction(
          runtimeUrl,
          { tenantId: state.tenantId, userId, role: "owner" },
          (sql) =>
            operation(sql, { userId, tenant: { tenantId: state.tenantId } }),
        );
    });
    afterAll(async () => {
      for (const tenant of [tenantA, tenantB])
        await admin`DELETE FROM tenants WHERE id=${tenant}::uuid`;
      await admin`DELETE FROM users WHERE id=${userId}::uuid`;
      await admin.end({ timeout: 2 });
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });
    const post = (body: Record<string, unknown>) =>
      POST(
        new Request("http://localhost/api/email/oauth/configuration", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const saved = () =>
      withTenantTransaction(
        runtimeUrl,
        { tenantId: state.tenantId, userId, role: "owner" },
        (sql) => readOAuthCredential<OAuthClientConfiguration>(sql, "google"),
      );
    const envelope = () =>
      admin<
        EnvelopeRow[]
      >`SELECT id,ciphertext,nonce,key_version,rotated_at FROM platform.credential_records WHERE tenant_id=${state.tenantId}::uuid AND kind='email_oauth_client_google'`;

    it("preserves existing encrypted credentials on blank/unrelated saves and reload; replaces only explicit nonempty secret", async () => {
      state.tenantId = tenantA;
      expect((await GET()).status).toBe(200);
      expect(await (await GET()).json()).toEqual({
        google: false,
        microsoft: false,
      });
      const original = {
        provider: "google",
        expectedTenantId: tenantA,
        clientId: "fictional-client-a",
        clientSecret: "fictional-secret-a",
      };
      expect((await post(original)).status).toBe(200);
      const before = await envelope();
      const summary = JSON.stringify(await (await GET()).json());
      expect(summary).toBe('{"google":true,"microsoft":false}');
      expect(summary).not.toContain(original.clientSecret);
      for (const omitted of [undefined, "", "   "]) {
        expect(
          (await post({ ...original, clientSecret: omitted })).status,
        ).toBe(400);
        expect(await envelope()).toEqual(before);
      }
      const settings = await saveSettings(
        new Request("http://localhost/api/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tenantName: "Fictional renamed tenant",
            displayName: "Fictional display",
            defaultCurrency: "ILS",
            locale: "he",
            timezone: "Asia/Jerusalem",
            clientSecret: "must-not-be-saved",
            credentialId: before[0]?.id,
          }),
        }),
      );
      expect(settings.status).toBe(200);
      expect(await envelope()).toEqual(before);
      // A fresh transaction/read represents reload; another tenant sees no config.
      expect((await saved())?.clientSecret).toBe(original.clientSecret);
      state.tenantId = tenantB;
      expect(await (await GET()).json()).toEqual({
        google: false,
        microsoft: false,
      });
      state.tenantId = tenantA;
      expect((await saved())?.clientSecret).toBe(original.clientSecret);
      expect(
        (
          await post({
            ...original,
            clientSecret: "fictional-explicit-replacement",
          })
        ).status,
      ).toBe(200);
      const after = await envelope();
      expect(after[0]?.id).toBe(before[0]?.id);
      expect(after[0]?.ciphertext).not.toEqual(before[0]?.ciphertext);
      expect((await saved())?.clientSecret).toBe(
        "fictional-explicit-replacement",
      );
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("rejects a stale credential form after the authenticated active tenant changes", async () => {
      state.tenantId = tenantB;
      expect(
        (
          await post({
            provider: "google",
            expectedTenantId: tenantB,
            clientId: "fictional-client-b",
            clientSecret: "fictional-secret-b",
          })
        ).status,
      ).toBe(200);
      const before = await envelope();
      const stale = await post({
        provider: "google",
        expectedTenantId: tenantA,
        clientId: "stale-client-a",
        clientSecret: "stale-secret-a",
      });
      expect(stale.status).toBe(400);
      expect(await envelope()).toEqual(before);
      expect((await saved())?.clientSecret).toBe("fictional-secret-b");
      const started = await startOAuth(
        new Request(
          `http://localhost/api/email/oauth/google/start?expectedTenantId=${tenantA}`,
        ),
        { params: Promise.resolve({ provider: "google" }) },
      );
      expect(started.status).toBe(400);
      expect(await envelope()).toEqual(before);
      expect(fetcher).not.toHaveBeenCalled();
    });
  },
);
