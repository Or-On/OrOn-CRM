import postgres from "postgres";

import type { Role } from "./authorization.js";

export interface TenantExecutionIdentity {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: Role;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function withTenantTransaction<T>(
  databaseUrl: string,
  identity: TenantExecutionIdentity,
  operation: (transaction: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  if (!/^postgres(?:ql)?:\/\//u.test(databaseUrl))
    throw new TypeError("databaseUrl must use PostgreSQL");
  if (
    !uuidPattern.test(identity.tenantId) ||
    !uuidPattern.test(identity.userId)
  ) {
    throw new TypeError("tenant and user context must use UUID identifiers");
  }
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    return (await sql.begin(async (transaction) => {
      await transaction`
        SELECT set_config('app.current_tenant', ${identity.tenantId}, true),
               set_config('app.current_user', ${identity.userId}, true),
               set_config('app.current_role', ${identity.role}, true)
      `;
      return operation(transaction);
    })) as T;
  } finally {
    await sql.end({ timeout: 2 });
  }
}
