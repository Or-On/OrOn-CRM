import type postgres from "postgres";

import type {
  NotificationSummary,
  TeamMember,
  TenantSettings,
} from "./types.js";

export async function listTeamMembers(
  sql: postgres.TransactionSql,
): Promise<readonly TeamMember[]> {
  return sql<TeamMember[]>`
    SELECT membership.user_id AS "userId", user_account.email,
           membership.role
    FROM memberships membership
    JOIN users user_account ON user_account.id = membership.user_id
    WHERE membership.tenant_id = platform.current_tenant_id()
    ORDER BY lower(user_account.email), membership.user_id
  `;
}

export async function getTenantSettings(
  sql: postgres.TransactionSql,
): Promise<TenantSettings> {
  const rows = await sql<
    {
      display_name: string | null;
      default_currency: string;
      locale: string;
      timezone: string;
    }[]
  >`
    SELECT display_name, default_currency, locale, timezone
    FROM crm.tenant_settings
  `;
  const row = rows[0];
  if (row === undefined) {
    return {
      displayName: null,
      defaultCurrency: "USD",
      locale: "en",
      timezone: "UTC",
    };
  }
  return {
    displayName: row.display_name,
    defaultCurrency: row.default_currency,
    locale: row.locale,
    timezone: row.timezone,
  };
}

export async function updateTenantSettings(
  sql: postgres.TransactionSql,
  input: TenantSettings,
): Promise<TenantSettings> {
  const currency = input.defaultCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency))
    throw new TypeError("currency must use a three-letter ISO code");
  const locale = input.locale.trim();
  const timezone = input.timezone.trim();
  const displayName = input.displayName?.trim();
  if (!locale || !timezone)
    throw new TypeError("locale and timezone are required");
  const rows = await sql<
    {
      display_name: string | null;
      default_currency: string;
      locale: string;
      timezone: string;
    }[]
  >`
    INSERT INTO crm.tenant_settings
      (tenant_id, display_name, default_currency, locale, timezone)
    VALUES (platform.current_tenant_id(), ${displayName === "" ? null : (displayName ?? null)},
            ${currency}, ${locale}, ${timezone})
    ON CONFLICT (tenant_id) DO UPDATE
      SET display_name = EXCLUDED.display_name,
          default_currency = EXCLUDED.default_currency,
          locale = EXCLUDED.locale, timezone = EXCLUDED.timezone,
          updated_at = CURRENT_TIMESTAMP
    RETURNING display_name, default_currency, locale, timezone
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("tenant settings update failed");
  return {
    displayName: row.display_name,
    defaultCurrency: row.default_currency,
    locale: row.locale,
    timezone: row.timezone,
  };
}

export async function listNotifications(
  sql: postgres.TransactionSql,
  userId: string,
): Promise<readonly NotificationSummary[]> {
  const rows = await sql<
    {
      id: string;
      title: string;
      body: string | null;
      read_at: Date | null;
      created_at: Date;
    }[]
  >`
    SELECT id, title, body, read_at, created_at
    FROM messaging.notifications WHERE user_id = ${userId}::uuid
    ORDER BY created_at DESC, id DESC LIMIT 50
  `;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    read: row.read_at !== null,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function markNotificationRead(
  sql: postgres.TransactionSql,
  userId: string,
  notificationId: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE messaging.notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE id = ${notificationId}::uuid AND user_id = ${userId}::uuid RETURNING id
  `;
  return rows.length === 1;
}
