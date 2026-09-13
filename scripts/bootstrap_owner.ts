import { stat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import postgres from "postgres";

import { hashPassword } from "../packages/ts/auth/src/crypto.js";

const MIGRATION_SEED_TENANT_ID = "00000000-0000-0000-0000-000000000001";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function deploymentInput(): {
  databaseUrl: string;
  email: string;
  name: string;
  slug: string;
  passwordFile: string;
} {
  if (process.env.PLATFORM_ENV !== "production")
    throw new Error("PLATFORM_ENV=production is required for first-owner bootstrap");
  if (!process.argv.includes("--confirm-empty-database"))
    throw new Error("Explicit --confirm-empty-database acknowledgement is required");
  const databaseUrl = required("MIGRATION_DATABASE_URL");
  if (!/^postgres(?:ql)?:\/\//u.test(databaseUrl))
    throw new Error("MIGRATION_DATABASE_URL must use PostgreSQL");
  const email = required("BOOTSTRAP_OWNER_EMAIL").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 320)
    throw new Error("BOOTSTRAP_OWNER_EMAIL must be a valid email address");
  const name = required("BOOTSTRAP_TENANT_NAME");
  if (name.length < 2 || name.length > 120)
    throw new Error("BOOTSTRAP_TENANT_NAME must contain 2-120 characters");
  const slug = required("BOOTSTRAP_TENANT_SLUG").toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || slug.length > 63)
    throw new Error("BOOTSTRAP_TENANT_SLUG must be a valid URL slug");
  const passwordFile = required("BOOTSTRAP_OWNER_PASSWORD_FILE");
  if (!isAbsolute(passwordFile))
    throw new Error("BOOTSTRAP_OWNER_PASSWORD_FILE must be an absolute path");
  return { databaseUrl, email, name, slug, passwordFile: resolve(passwordFile) };
}

async function privatePassword(path: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Owner password path must be a regular file");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    throw new Error("Owner password file must not be accessible by group or others");
  const source = await readFile(path, "utf8");
  const password = source.replace(/\r?\n$/u, "");
  if (password.includes("\n") || password.includes("\r"))
    throw new Error("Owner password file must contain exactly one line");
  if (password.length < 14 || password.length > 256)
    throw new Error("Owner password must contain 14-256 characters");
  return password;
}

async function main(): Promise<void> {
  const input = deploymentInput();
  const passwordHash = await hashPassword(await privatePassword(input.passwordFile));
  const bootstrapUserId = randomUUID();
  const sql = postgres(input.databaseUrl, {
    connect_timeout: 5,
    idle_timeout: 5,
    max: 1,
    prepare: false,
  });
  try {
    await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(726443819443)`;
      const counts = await transaction<
        { memberships: string; tenants: string; users: string }[]
      >`
        SELECT
          (SELECT count(*)::text FROM tenants) AS tenants,
          (SELECT count(*)::text FROM users) AS users,
          (SELECT count(*)::text FROM memberships) AS memberships
      `;
      const seedTenants = await transaction<{ id: string }[]>`
        SELECT id::text AS id
        FROM tenants
        WHERE id = ${MIGRATION_SEED_TENANT_ID}::uuid
          AND name = 'Default'
          AND slug = 'default'
          AND status = 'active'
      `;
      if (
        counts[0].tenants !== "1" ||
        counts[0].users !== "0" ||
        counts[0].memberships !== "0" ||
        seedTenants.length !== 1
      )
        throw new Error("First-owner bootstrap refuses a non-empty identity database");

      const tenants = await transaction<{ id: string }[]>`
        UPDATE tenants
        SET name = ${input.name}, slug = ${input.slug}, updated_at = now()
        WHERE id = ${MIGRATION_SEED_TENANT_ID}::uuid
        RETURNING id
      `;
      const users = await transaction<{ id: string }[]>`
        INSERT INTO users(id, email, display_name, is_superuser, status)
        VALUES(
          ${bootstrapUserId}::uuid,
          ${input.email},
          'Platform Administrator',
          true,
          'active'
        )
        RETURNING id
      `;
      const tenantId = tenants[0]?.id;
      const userId = users[0]?.id;
      if (!tenantId || !userId) throw new Error("Bootstrap identifiers were not returned");
      await transaction`
        INSERT INTO memberships(user_id, tenant_id, role)
        VALUES(${userId}::uuid, ${tenantId}::uuid, 'owner')
      `;
      await transaction`
        UPDATE crm.tenant_settings
        SET display_name = ${input.name}, default_currency = 'USD', locale = 'en', timezone = 'UTC'
        WHERE tenant_id = ${tenantId}::uuid
      `;
      await transaction`
        UPDATE billing.wallets
        SET currency = 'USD'
        WHERE tenant_id = ${tenantId}::uuid
      `;
      await transaction`
        INSERT INTO platform.auth_credentials(user_id, password_hash)
        VALUES(${userId}::uuid, ${passwordHash})
      `;
      await transaction`
        INSERT INTO audit.records(
          tenant_id, actor_user_id, action, target_type, target_id, request_id, metadata
        ) VALUES(
          ${tenantId}::uuid, ${userId}::uuid, 'platform.bootstrap_owner',
          'user', ${userId}::uuid, 'operator-first-owner-bootstrap',
          jsonb_build_object('source', 'operator_cli')
        )
      `;
    });
    console.log("First platform owner and workspace created successfully");
  } finally {
    await sql.end({ timeout: 2 });
  }
}

void main().catch((error: unknown) => {
  console.error("First-owner bootstrap failed", {
    message: error instanceof Error ? error.message : "unknown error",
  });
  process.exitCode = 1;
});
