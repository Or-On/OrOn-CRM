import postgres, { type Sql } from "postgres";

/**
 * New cross-system composition belongs here. Mature upstream engines and domain
 * models retain their own package identities during later integration.
 */
export const PLATFORM_INTEGRATION_BOUNDARY = "platform-integration.v1" as const;

export interface PostgresProbe {
  readonly isReady: () => Promise<boolean>;
  readonly close: () => Promise<void>;
}

export function createPostgresProbe(databaseUrl: string): PostgresProbe {
  if (!/^postgres(?:ql)?:\/\//u.test(databaseUrl)) {
    throw new TypeError("databaseUrl must use PostgreSQL");
  }

  const sql: Sql = postgres(databaseUrl, {
    connect_timeout: 2,
    idle_timeout: 5,
    max: 2,
  });

  return {
    async isReady(): Promise<boolean> {
      try {
        await sql`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 2 });
    },
  };
}
