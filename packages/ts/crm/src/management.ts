import type postgres from "postgres";

import type {
  NotificationSummary,
  TeamMember,
  TenantInvitationSummary,
  TenantSettings,
  StoredIdentityImage,
} from "./types.js";

type TenantAccentToken = Exclude<TenantSettings["accentToken"], undefined>;

interface StoredIdentityImageRow {
  readonly data: Uint8Array;
  readonly content_type: StoredIdentityImage["contentType"];
  readonly updated_at: Date;
}

function storedImage(
  row: StoredIdentityImageRow | undefined,
): StoredIdentityImage | undefined {
  return row === undefined
    ? undefined
    : {
        data: row.data,
        contentType: row.content_type,
        updatedAt: row.updated_at.toISOString(),
      };
}

export async function getCurrentUserAvatar(
  sql: postgres.TransactionSql,
): Promise<StoredIdentityImage | undefined> {
  const rows = await sql<StoredIdentityImageRow[]>`
    SELECT data, content_type, updated_at FROM platform.current_user_avatar()
  `;
  return storedImage(rows[0]);
}

export async function setCurrentUserAvatar(
  sql: postgres.TransactionSql,
  image:
    { readonly data: Uint8Array; readonly contentType: string } | undefined,
  requestId: string,
): Promise<void> {
  await sql`
    SELECT platform.set_current_user_avatar(
      ${image?.data ?? null}::bytea, ${image?.contentType ?? null}::text,
      ${requestId}::text
    )
  `;
}

export async function getCurrentTenantLogo(
  sql: postgres.TransactionSql,
): Promise<StoredIdentityImage | undefined> {
  const rows = await sql<StoredIdentityImageRow[]>`
    SELECT data, content_type, updated_at FROM platform.current_tenant_logo()
  `;
  return storedImage(rows[0]);
}

export async function setCurrentTenantLogo(
  sql: postgres.TransactionSql,
  image:
    { readonly data: Uint8Array; readonly contentType: string } | undefined,
  requestId: string,
): Promise<void> {
  await sql`
    SELECT platform.set_current_tenant_logo(
      ${image?.data ?? null}::bytea, ${image?.contentType ?? null}::text,
      ${requestId}::text
    )
  `;
}

export async function listTeamMembers(
  sql: postgres.TransactionSql,
): Promise<readonly TeamMember[]> {
  return sql<TeamMember[]>`
    SELECT user_id AS "userId", email, display_name AS "displayName", role
    FROM platform.current_tenant_team()
    ORDER BY lower(email), user_id
  `;
}

export async function listTenantInvitations(
  sql: postgres.TransactionSql,
): Promise<readonly TenantInvitationSummary[]> {
  const rows = await sql<
    {
      id: string;
      email: string;
      role: TenantInvitationSummary["role"];
      expires_at: Date;
      created_at: Date;
    }[]
  >`
    SELECT id, email, role, expires_at, created_at
    FROM platform.current_tenant_invitations()
  `;
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  }));
}

export async function createTenantInvitation(
  sql: postgres.TransactionSql,
  input: {
    readonly email: string;
    readonly role: TenantInvitationSummary["role"];
    readonly tokenHash: string;
    readonly requestId: string;
  },
): Promise<string> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 320)
    throw new TypeError("a valid invitation email is required");
  const rows = await sql<{ id: string }[]>`
    SELECT platform.create_current_tenant_invitation(
      ${email}::citext, ${input.role}::text, ${input.tokenHash}::text,
      ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)}::timestamptz,
      ${input.requestId}::text
    ) AS id
  `;
  const id = rows[0]?.id;
  if (id === undefined)
    throw new Error("invitation creation returned no identifier");
  return id;
}

export async function revokeTenantInvitation(
  sql: postgres.TransactionSql,
  invitationId: string,
  requestId: string,
): Promise<boolean> {
  const rows = await sql<{ revoked: boolean }[]>`
    SELECT platform.revoke_current_tenant_invitation(
      ${invitationId}::uuid, ${requestId}::text
    ) AS revoked
  `;
  return rows[0]?.revoked === true;
}

export async function updateCurrentTenantName(
  sql: postgres.TransactionSql,
  name: string,
  requestId: string,
): Promise<string> {
  const rows = await sql<{ name: string }[]>`
    SELECT platform.update_current_tenant_name(${name}::text, ${requestId}::text) AS name
  `;
  const updated = rows[0]?.name;
  if (updated === undefined) throw new Error("tenant name update failed");
  return updated;
}

export async function updateCurrentUserProfile(
  sql: postgres.TransactionSql,
  displayName: string,
  email: string,
  requestId: string,
): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalizedEmail))
    throw new TypeError("a valid email is required");
  if (displayName.trim().length > 120)
    throw new TypeError("display name is too long");
  await sql`
    SELECT platform.update_current_user_profile(
      ${displayName}::text, ${normalizedEmail}::citext, ${requestId}::text
    )
  `;
}

export async function changeCurrentUserPassword(
  sql: postgres.TransactionSql,
  passwordHash: string,
  sessionId: string,
  requestId: string,
): Promise<void> {
  await sql`
    SELECT platform.change_current_user_password(
      ${passwordHash}::text, ${sessionId}::uuid, ${requestId}::text
    )
  `;
}

export async function updateTenantMember(
  sql: postgres.TransactionSql,
  input: {
    readonly userId: string;
    readonly role: TeamMember["role"];
    readonly remove?: boolean;
    readonly requestId: string;
  },
): Promise<void> {
  await sql`
    SELECT platform.manage_current_tenant_member(
      ${input.userId}::uuid, ${input.role}::text,
      ${input.remove === true}::boolean, ${input.requestId}::text
    )
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
      business_name: string | null;
      business_email: string | null;
      business_phone: string | null;
      business_address: string | null;
      accent_token: TenantAccentToken;
      report_header: string | null;
      report_footer: string | null;
    }[]
  >`
    SELECT display_name, default_currency, locale, timezone,
           business_name, business_email, business_phone, business_address,
           accent_token, report_header, report_footer
    FROM crm.tenant_settings
  `;
  const row = rows[0];
  if (row === undefined) {
    return {
      displayName: null,
      defaultCurrency: "USD",
      locale: "en",
      timezone: "UTC",
      businessName: null,
      businessEmail: null,
      businessPhone: null,
      businessAddress: null,
      accentToken: null,
      reportHeader: null,
      reportFooter: null,
    };
  }
  return {
    displayName: row.display_name,
    defaultCurrency: row.default_currency,
    locale: row.locale,
    timezone: row.timezone,
    businessName: row.business_name,
    businessEmail: row.business_email,
    businessPhone: row.business_phone,
    businessAddress: row.business_address,
    accentToken: row.accent_token,
    reportHeader: row.report_header,
    reportFooter: row.report_footer,
  };
}

function tenantSettingText(
  value: string | null | undefined,
  maximum: number,
): string | null {
  const normalized = value?.trim() ?? "";
  if (normalized.length > maximum)
    throw new TypeError("workspace branding value is too long");
  return normalized === "" ? null : normalized;
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
  const businessName = tenantSettingText(input.businessName, 160);
  const businessEmail = tenantSettingText(input.businessEmail, 320);
  const businessPhone = tenantSettingText(input.businessPhone, 40);
  const businessAddress = tenantSettingText(input.businessAddress, 500);
  const reportHeader = tenantSettingText(input.reportHeader, 500);
  const reportFooter = tenantSettingText(input.reportFooter, 1_000);
  const accentToken = input.accentToken ?? null;
  if (
    accentToken !== null &&
    !["blue", "cyan", "emerald", "violet", "amber", "rose"].includes(
      accentToken,
    )
  )
    throw new TypeError("unsupported workspace accent");
  if (
    businessEmail !== null &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(businessEmail)
  )
    throw new TypeError("business email must be valid");
  if (!locale || !timezone)
    throw new TypeError("locale and timezone are required");
  if (timezone.length > 100)
    throw new TypeError("timezone must be a valid IANA time-zone name");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  } catch {
    throw new TypeError("timezone must be a valid IANA time-zone name");
  }
  const rows = await sql<
    {
      display_name: string | null;
      default_currency: string;
      locale: string;
      timezone: string;
      business_name: string | null;
      business_email: string | null;
      business_phone: string | null;
      business_address: string | null;
      accent_token: TenantAccentToken;
      report_header: string | null;
      report_footer: string | null;
    }[]
  >`
    INSERT INTO crm.tenant_settings
      (tenant_id, display_name, default_currency, locale, timezone,
       business_name, business_email, business_phone, business_address,
       accent_token, report_header, report_footer)
    VALUES (platform.current_tenant_id(), ${displayName === "" ? null : (displayName ?? null)},
            ${currency}, ${locale}, ${timezone}, ${businessName}, ${businessEmail},
            ${businessPhone}, ${businessAddress}, ${accentToken},
            ${reportHeader}, ${reportFooter})
    ON CONFLICT (tenant_id) DO UPDATE
      SET display_name = EXCLUDED.display_name,
          default_currency = EXCLUDED.default_currency,
          locale = EXCLUDED.locale, timezone = EXCLUDED.timezone,
          business_name = CASE WHEN ${input.businessName !== undefined}
            THEN EXCLUDED.business_name ELSE crm.tenant_settings.business_name END,
          business_email = CASE WHEN ${input.businessEmail !== undefined}
            THEN EXCLUDED.business_email ELSE crm.tenant_settings.business_email END,
          business_phone = CASE WHEN ${input.businessPhone !== undefined}
            THEN EXCLUDED.business_phone ELSE crm.tenant_settings.business_phone END,
          business_address = CASE WHEN ${input.businessAddress !== undefined}
            THEN EXCLUDED.business_address ELSE crm.tenant_settings.business_address END,
          accent_token = CASE WHEN ${input.accentToken !== undefined}
            THEN EXCLUDED.accent_token ELSE crm.tenant_settings.accent_token END,
          report_header = CASE WHEN ${input.reportHeader !== undefined}
            THEN EXCLUDED.report_header ELSE crm.tenant_settings.report_header END,
          report_footer = CASE WHEN ${input.reportFooter !== undefined}
            THEN EXCLUDED.report_footer ELSE crm.tenant_settings.report_footer END,
          updated_at = CURRENT_TIMESTAMP
    RETURNING display_name, default_currency, locale, timezone,
      business_name, business_email, business_phone, business_address,
      accent_token, report_header, report_footer
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("tenant settings update failed");
  return {
    displayName: row.display_name,
    defaultCurrency: row.default_currency,
    locale: row.locale,
    timezone: row.timezone,
    businessName: row.business_name,
    businessEmail: row.business_email,
    businessPhone: row.business_phone,
    businessAddress: row.business_address,
    accentToken: row.accent_token,
    reportHeader: row.report_header,
    reportFooter: row.report_footer,
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
      reference_type: string | null;
      reference_id: string | null;
      type: string;
    }[]
  >`
    SELECT id, title, body, read_at, created_at, reference_type, reference_id, type
    FROM messaging.notifications WHERE user_id = ${userId}::uuid
    ORDER BY created_at DESC, id DESC LIMIT 50
  `;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    read: row.read_at !== null,
    createdAt: row.created_at.toISOString(),
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    type: row.type,
  }));
}

export async function markAllNotificationsRead(
  sql: postgres.TransactionSql,
  userId: string,
): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE messaging.notifications
    SET read_at=CURRENT_TIMESTAMP
    WHERE user_id=${userId}::uuid AND read_at IS NULL
    RETURNING id
  `;
  return rows.length;
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
