import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  AuthService,
  createAuthRepository,
  hashPassword,
  withTenantTransaction,
  type AuthSession,
  type TenantTransaction,
} from "./index.js";

const databaseUrl = process.env.AUTH_TEST_DATABASE_URL;
const pepper = "multi-session-test-pepper-with-thirty-two-safe-characters";

function localDatabase(): string {
  if (databaseUrl === undefined)
    throw new Error("AUTH_TEST_DATABASE_URL is required");
  const target = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname))
    throw new Error("Only a local fictional PostgreSQL fixture is permitted");
  return databaseUrl;
}

describe.skipIf(databaseUrl === undefined)(
  "one shared technician account on many devices (PostgreSQL)",
  () => {
    it("keeps simultaneous logins independent and resolves one technician per session", async () => {
      const url = localDatabase();
      const admin = postgres(url, { max: 1, prepare: false });
      const repository = createAuthRepository(url);
      const tenantId = randomUUID();
      const userId = randomUUID();
      const suffix = randomUUID().slice(0, 8);
      const email = `technicians-${suffix}@example.invalid`;
      const password = "fictional shared technician password";
      try {
        const technicians = await admin.begin(async (sql) => {
          await sql`
            INSERT INTO public.tenants(id,name,slug,status)
            VALUES(${tenantId}::uuid,'Fictional shared technicians',
                   ${`shared-technicians-${suffix}`},'active')
          `;
          await sql`
            INSERT INTO public.users(id,email,display_name,status)
            VALUES(${userId}::uuid,${email},'Fictional shared technicians','active')
          `;
          await sql`
            INSERT INTO platform.auth_credentials(user_id,password_hash)
            VALUES(${userId}::uuid,${await hashPassword(password)})
          `;
          await sql`
            INSERT INTO public.memberships(tenant_id,user_id,role)
            VALUES(${tenantId}::uuid,${userId}::uuid,'technician')
          `;
          await sql`
            INSERT INTO platform.tenant_feature_entitlements(
              tenant_id,feature_key,available,granted_at
            ) VALUES(${tenantId}::uuid,'field_service',true,CURRENT_TIMESTAMP)
          `;
          await sql`
            INSERT INTO service.tenant_configuration(
              tenant_id,enabled,shared_technician_login_enabled
            ) VALUES(${tenantId}::uuid,true,true)
          `;
          return sql<{ id: string; full_name: string }[]>`
            INSERT INTO service.technicians(tenant_id,full_name,employee_identifier)
            VALUES(${tenantId}::uuid,'David Fixture','FS-DAVID'),
                  (${tenantId}::uuid,'Moshe Fixture','FS-MOSHE')
            RETURNING id, full_name
          `;
        });
        const david = technicians.find(
          (row) => row.full_name === "David Fixture",
        )?.id;
        const moshe = technicians.find(
          (row) => row.full_name === "Moshe Fixture",
        )?.id;
        if (david === undefined || moshe === undefined)
          throw new Error("technician fixtures were not created");

        const service = new AuthService(repository, {
          dummyPasswordHash: await hashPassword("fictional dummy password"),
          tokenPepper: pepper,
        });
        const tabletA = await service.login({
          email,
          password,
          requestId: "shared-login-a",
        });
        const tabletB = await service.login({
          email,
          password,
          requestId: "shared-login-b",
        });
        expect(tabletA.session.userId).toBe(tabletB.session.userId);
        expect(tabletA.session.sessionId).not.toBe(tabletB.session.sessionId);
        // The second login did not invalidate the first device.
        expect((await service.resolve(tabletA.sessionToken))?.sessionId).toBe(
          tabletA.session.sessionId,
        );
        expect((await service.resolve(tabletB.sessionToken))?.sessionId).toBe(
          tabletB.session.sessionId,
        );
        expect(service.toPublicSession(tabletA.session).applicationScope).toBe(
          "field-service",
        );

        const inSession = <T>(
          session: AuthSession,
          work: (sql: TenantTransaction) => Promise<T>,
        ) =>
          withTenantTransaction(
            url,
            {
              tenantId,
              userId,
              role: session.tenant.role,
              sessionId: session.sessionId,
            },
            async (sql) => {
              await sql`SET LOCAL ROLE platform_web`;
              return work(sql);
            },
          );
        const technicianOf = (session: AuthSession) =>
          inSession(session, async (sql) => {
            const rows = await sql<{ id: string | null }[]>`
              SELECT service.current_session_technician_id() AS id
            `;
            return rows[0]?.id ?? null;
          });
        const bind = (
          session: AuthSession,
          technicianId: string,
          identifier: string,
        ) =>
          inSession(
            session,
            (sql) => sql`
              SELECT service.bind_current_technician_session(
                ${technicianId}::uuid, ${identifier}, ${randomUUID()}
              )
            `,
          );

        await bind(tabletA.session, david, "FS-DAVID");
        expect(await technicianOf(tabletB.session)).toBeNull();
        await bind(tabletB.session, moshe, "FS-MOSHE");

        // Interleaved concurrent requests never share process or user state.
        const interleaved = await Promise.all(
          Array.from({ length: 12 }, (_, index) =>
            technicianOf(index % 2 === 0 ? tabletA.session : tabletB.session),
          ),
        );
        expect(interleaved).toEqual(
          Array.from({ length: 12 }, (_, index) =>
            index % 2 === 0 ? david : moshe,
          ),
        );

        await service.logout(tabletA.sessionToken, "shared-logout-a");
        expect(await service.resolve(tabletA.sessionToken)).toBeUndefined();
        expect((await service.resolve(tabletB.sessionToken))?.sessionId).toBe(
          tabletB.session.sessionId,
        );
        expect(await technicianOf(tabletA.session)).toBeNull();
        expect(await technicianOf(tabletB.session)).toBe(moshe);
      } finally {
        await repository.close();
        // Technician rows are feature-guarded, so remove them while the
        // tenant's modules still exist; bindings cascade with them.
        await admin`DELETE FROM service.technicians WHERE tenant_id=${tenantId}::uuid`;
        await admin`DELETE FROM public.tenants WHERE id=${tenantId}::uuid`;
        await admin`DELETE FROM public.users WHERE id=${userId}::uuid`;
        await admin.end({ timeout: 2 });
      }
    });
  },
);
