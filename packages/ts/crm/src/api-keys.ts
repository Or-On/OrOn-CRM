import { createHmac, randomBytes, randomUUID } from "node:crypto";

import postgres from "postgres";

export const apiKeyScopes = ["crm:read", "crm:write"] as const;
export type ApiKeyScope = (typeof apiKeyScopes)[number];

export interface ApiKeySummary {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly status: string;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

function digestApiKey(token: string, pepper: string): string {
  return createHmac("sha256", pepper).update(token).digest("hex");
}

export async function createApiKey(
  sql: postgres.TransactionSql,
  actorUserId: string,
  pepper: string,
  name: string,
  requestedScopes: readonly string[],
): Promise<{ readonly token: string; readonly key: ApiKeySummary }> {
  const normalizedName = name.trim();
  if (!normalizedName) throw new TypeError("API key name is required");
  const scopes = [...new Set(requestedScopes)];
  if (
    scopes.length === 0 ||
    scopes.some((scope) => !apiKeyScopes.includes(scope as ApiKeyScope))
  ) {
    throw new TypeError("API key contains an unsupported scope");
  }
  const token = `oron_${randomBytes(32).toString("base64url")}`;
  const prefix = token.slice(0, 13);
  const rows = await sql<
    {
      id: string;
      name: string;
      prefix: string;
      scopes: string[];
      status: string;
      last_used_at: Date | null;
      created_at: Date;
    }[]
  >`
    INSERT INTO api_keys
      (id, hashed_key, tenant_id, kind, status, name, prefix, scopes,
       created_by_user_id)
    VALUES (${randomUUID()}::uuid, ${digestApiKey(token, pepper)},
            platform.current_tenant_id(), 'tenant', 'active', ${normalizedName},
            ${prefix}, ${scopes}, ${actorUserId}::uuid)
    RETURNING id, name, prefix, scopes, status, last_used_at, created_at
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("API key creation failed");
  return {
    token,
    key: {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: row.scopes,
      status: row.status,
      lastUsedAt: row.last_used_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    },
  };
}

export async function listApiKeys(
  sql: postgres.TransactionSql,
): Promise<readonly ApiKeySummary[]> {
  const rows = await sql<
    {
      id: string;
      name: string;
      prefix: string;
      scopes: string[];
      status: string;
      last_used_at: Date | null;
      created_at: Date;
    }[]
  >`
    SELECT id, name, prefix, scopes, status, last_used_at, created_at
    FROM api_keys ORDER BY created_at DESC, id DESC
  `;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    status: row.status,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function revokeApiKey(
  sql: postgres.TransactionSql,
  id: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE api_keys SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid AND status = 'active' RETURNING id
  `;
  return rows.length === 1;
}

export async function withApiKeyTenant<T>(
  databaseUrl: string,
  pepper: string,
  token: string,
  requiredScope: ApiKeyScope,
  operation: (transaction: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  if (!token.startsWith("oron_") || token.length < 40)
    throw new TypeError("invalid API key");
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    return (await sql.begin(async (transaction) => {
      const resolved = await transaction<
        { resolved_tenant_id: string; resolved_scopes: string[] }[]
      >`
      SELECT * FROM platform.resolve_api_key(${digestApiKey(token, pepper)})
    `;
      const identity = resolved[0];
      if (!identity?.resolved_scopes.includes(requiredScope)) {
        throw new TypeError("invalid API key");
      }
      await transaction`
        SELECT set_config('app.current_tenant', ${identity.resolved_tenant_id}, true),
               set_config('app.current_role', 'api_key', true)
      `;
      return operation(transaction);
    })) as T;
  } finally {
    await sql.end({ timeout: 2 });
  }
}
