import { randomUUID } from "node:crypto";
import postgres from "postgres";

/** Global queue claimers require a database per scenario, not just new tenants. */
export async function createFairDatabaseFixture(source: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const target = new URL(source);
  if (
    target.hostname !== "127.0.0.1" ||
    target.port !== "55480" ||
    !/^\/oron_fair_[a-f0-9]{32}$/u.test(target.pathname)
  ) {
    throw new TypeError("Independent owned loopback fair template required");
  }
  const template = target.pathname.slice(1);
  const database = `oron_fair_${randomUUID().replaceAll("-", "")}`;
  const administrativeTarget = new URL(target);
  administrativeTarget.pathname = "/postgres";
  const admin = postgres(administrativeTarget.toString(), {
    max: 1,
    prepare: false,
  });
  let created = false;
  try {
    await admin`CREATE DATABASE ${admin(database)} TEMPLATE ${admin(template)}`;
    created = true;
    target.pathname = `/${database}`;
    return {
      url: target.toString(),
      close: async () => {
        try {
          if (created) {
            await admin`DROP DATABASE ${admin(database)} WITH (FORCE)`;
            created = false;
          }
        } finally {
          await admin.end();
        }
      },
    };
  } catch (error) {
    await admin.end();
    throw error;
  }
}
