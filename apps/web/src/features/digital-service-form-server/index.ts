import "server-only";
import { withProcessDatabase, isUuidIdentifier } from "@or-on/auth";
import { loadConfig } from "@or-on/config";
import type postgres from "postgres";

export function serviceFormIdentity(request: Request) {
  const tenant = request.headers.get("x-service-tenant") ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const token = /^Bearer ([0-9a-f]{64})$/u.exec(authorization)?.[1];
  if (!isUuidIdentifier(tenant) || token === undefined)
    throw Object.assign(new Error("Service form unavailable"), {
      code: "P0002",
    });
  return { tenant, token };
}

/** Tenant context narrows RLS; only the hashed bearer capability authorizes these functions. */
export async function withServiceForm<T>(
  tenant: string,
  operation: (sql: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const config = loadConfig(process.env, {
    service: "web",
    requireDatabase: true,
  });
  if (!config.databaseUrl) throw new Error("Service form database unavailable");
  return withProcessDatabase(
    config.databaseUrl,
    async (sql) =>
      (await sql.begin(async (transaction) => {
        await transaction`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user','',true),set_config('app.current_role','',true),set_config('app.current_session','',true)`;
        return operation(transaction);
      })) as T,
  );
}

export function assertServiceFormOrigin(request: Request): void {
  const config = loadConfig(process.env, { service: "web" });
  if (!config.publicSiteUrl) throw new Error("Service form origin unavailable");
  const expected = new URL(config.publicSiteUrl).origin;
  // No cookies or ambient user session authorize this route. A non-simple
  // bearer header plus this origin check prevents cross-origin browser posts.
  if (request.headers.get("origin") !== expected)
    throw Object.assign(new Error("Origin refused"), { code: "42501" });
}
