import postgres, { type Sql } from "postgres";

/** Ordinary web database paths share these trusted client options. */
export const PROCESS_DATABASE_MAX_CONNECTIONS = 4;
type ProcessDatabaseProfile = "runtime" | "whatsapp-verifier";
const profiles = {
  runtime: {
    connect_timeout: 3,
    idle_timeout: 10,
    max: PROCESS_DATABASE_MAX_CONNECTIONS,
    prepare: false,
  },
  "whatsapp-verifier": {
    connect_timeout: 2,
    idle_timeout: 10,
    max: 1,
    prepare: false,
  },
} as const;

interface PoolEntry {
  readonly sql: Sql;
  leases: number;
  readonly idle: Set<() => void>;
}
interface Registry {
  readonly pools: Map<string, PoolEntry>;
  hooksInstalled: boolean;
  stopping: boolean;
  closing?: Promise<void>;
}

// Next route bundles and development reloads can instantiate this module more
// than once. Keep only connection handles here, never tenant/session identity.
const registryKey = Symbol.for("or-on.process-postgres.v1");
const shared = globalThis as typeof globalThis & {
  [registryKey]: Registry | undefined;
};
function registry(): Registry {
  const existing = shared[registryKey];
  if (existing !== undefined) return existing;
  const created: Registry = {
    pools: new Map(),
    hooksInstalled: false,
    stopping: false,
  };
  shared[registryKey] = created;
  return created;
}

export interface DatabaseLease {
  readonly sql: Sql;
  release(): Promise<void>;
}

/** Internal lease: per-request cleanup releases ownership, not the process pool. */
export function acquireProcessDatabase(
  databaseUrl: string,
  profile: ProcessDatabaseProfile = "runtime",
): DatabaseLease {
  if (!/^postgres(?:ql)?:\/\//u.test(databaseUrl))
    throw new TypeError("databaseUrl must use PostgreSQL");
  if (!Object.hasOwn(profiles, profile))
    throw new TypeError("Unknown trusted database client profile");
  const clientOptions = profiles[profile];
  const state = registry();
  if (state.stopping || state.closing)
    throw new Error("Database pool is shutting down");
  installShutdownHooks(state);
  // Exact DSN equality includes credentials, role/options, TLS and database.
  // Do not canonicalize away query parameters or share a migrator's connection.
  const key = JSON.stringify([databaseUrl, clientOptions]);
  let entry = state.pools.get(key);
  if (!entry) {
    entry = {
      sql: postgres(databaseUrl, clientOptions),
      leases: 0,
      idle: new Set(),
    };
    state.pools.set(key, entry);
  }
  entry.leases += 1;
  let released = false;
  return {
    sql: entry.sql,
    release() {
      if (!released) {
        released = true;
        entry.leases -= 1;
        if (entry.leases === 0) {
          for (const resolve of entry.idle) resolve();
          entry.idle.clear();
        }
      }
      return Promise.resolve();
    },
  };
}

/** Database URL must come from validated server configuration, never a request. */
export async function withProcessDatabase<T>(
  databaseUrl: string,
  operation: (sql: Sql) => Promise<T>,
  profile: ProcessDatabaseProfile = "runtime",
): Promise<T> {
  const lease = acquireProcessDatabase(databaseUrl, profile);
  try {
    return await operation(lease.sql);
  } finally {
    await lease.release();
  }
}

/** Drain active operations, then close all physical connections with a bound. */
export function closeProcessDatabasePools(): Promise<void> {
  const state = registry();
  if (state.closing) return state.closing;
  const entries = [...state.pools.values()];
  state.closing = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(
          entries.map((entry) =>
            entry.leases === 0
              ? Promise.resolve()
              : new Promise<void>((resolve) => entry.idle.add(resolve)),
          ),
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5_000);
        }),
      ]);
      await Promise.all(entries.map((entry) => entry.sql.end({ timeout: 2 })));
    } finally {
      if (timer) clearTimeout(timer);
      for (const entry of entries) entry.idle.clear();
      state.pools.clear();
      delete state.closing;
    }
  })();
  return state.closing;
}

function installShutdownHooks(state: Registry): void {
  if (state.hooksInstalled) return;
  state.hooksInstalled = true;
  const stop = (signal?: "SIGTERM" | "SIGINT") => {
    state.stopping = true;
    // A server such as Next already owns process termination. Standalone users
    // of the shared pool retain normal signal termination after bounded drain.
    const serverOwnsSignal =
      signal !== undefined && process.listenerCount(signal) > 0;
    void closeProcessDatabasePools()
      .catch(() => undefined)
      .finally(() => {
        if (signal && !serverOwnsSignal) process.kill(process.pid, signal);
      });
  };
  process.once("beforeExit", () => stop());
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}
