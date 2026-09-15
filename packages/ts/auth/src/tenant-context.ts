import postgres from "postgres";

import type { Role } from "./authorization.js";

export type TenantTransaction = postgres.TransactionSql;

export interface TenantExecutionIdentity {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: Role;
  /**
   * The authenticated browser session, when the caller has one. Keeping this
   * in PostgreSQL's transaction-local context lets visit-scoped policies bind
   * shared technician identities to one session instead of one mutable user.
   */
  readonly sessionId?: string;
}

// PostgreSQL's uuid type accepts canonical UUID identifiers independently of
// RFC version/variant bits. Keep the application check equally strict about
// shape while allowing reserved identifiers such as the migration bootstrap
// tenant (00000000-0000-0000-0000-000000000001).
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isUuidIdentifier(value: string): boolean {
  return uuidPattern.test(value);
}

export async function withTenantTransaction<T>(
  databaseUrl: string,
  identity: TenantExecutionIdentity,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  if (!/^postgres(?:ql)?:\/\//u.test(databaseUrl))
    throw new TypeError("databaseUrl must use PostgreSQL");
  if (
    !isUuidIdentifier(identity.tenantId) ||
    !isUuidIdentifier(identity.userId) ||
    (identity.sessionId !== undefined && !isUuidIdentifier(identity.sessionId))
  ) {
    throw new TypeError(
      "tenant, user, and session context must use UUID identifiers",
    );
  }
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    return (await sql.begin(async (transaction) => {
      await transaction`
        SELECT set_config('app.current_tenant', ${identity.tenantId}, true),
               set_config('app.current_user', ${identity.userId}, true),
               set_config('app.current_role', ${identity.role}, true),
               set_config('app.current_session', ${identity.sessionId ?? ""}, true)
      `;
      return operation(transaction);
    })) as T;
  } finally {
    await sql.end({ timeout: 2 });
  }
}
