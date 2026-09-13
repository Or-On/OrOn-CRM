import type postgres from "postgres";

export interface PlatformTenantSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly defaultCurrency: string;
  readonly locale: "en" | "he";
  readonly timezone: string;
  readonly memberCount: number;
  readonly createdAt: string;
}

export async function listPlatformTenants(
  sql: postgres.TransactionSql,
): Promise<readonly PlatformTenantSummary[]> {
  const rows = await sql<
    {
      id: string;
      name: string;
      slug: string;
      status: string;
      default_currency: string;
      locale: "en" | "he";
      timezone: string;
      member_count: string;
      created_at: Date;
    }[]
  >`SELECT * FROM platform.list_tenants_for_administrator()`;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    defaultCurrency: row.default_currency,
    locale: row.locale,
    timezone: row.timezone,
    memberCount: Number(row.member_count),
    createdAt: row.created_at.toISOString(),
  }));
}

export async function createTenantWithDefaults(
  sql: postgres.TransactionSql,
  input: {
    readonly name: string;
    readonly slug: string;
    readonly currency: string;
    readonly locale: "en" | "he";
    readonly timezone: string;
    readonly ownerEmail?: string;
  },
): Promise<string> {
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  const currency = input.currency.trim().toUpperCase();
  const timezone = input.timezone.trim();
  const normalizedOwnerEmail = input.ownerEmail?.trim().toLowerCase();
  const ownerEmail =
    normalizedOwnerEmail !== undefined && normalizedOwnerEmail.length > 0
      ? normalizedOwnerEmail
      : null;
  if (
    !name ||
    name.length > 120 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) ||
    slug.length > 63
  )
    throw new TypeError("Enter a valid tenant name and URL slug");
  if (!/^[A-Z]{3}$/u.test(currency) || !timezone || timezone.length > 100)
    throw new TypeError("Enter a valid currency and timezone");
  const rows = await sql<{ id: string }[]>`
    SELECT platform.create_tenant_with_defaults(
      ${name}, ${slug}, ${currency}, ${input.locale}, ${timezone}, ${ownerEmail}::citext
    ) AS id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error("Tenant creation returned no identifier");
  return id;
}

export async function deleteTenantForAdministrator(
  sql: postgres.TransactionSql,
  tenantId: string,
  requestId: string,
): Promise<boolean> {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(tenantId))
    throw new TypeError("Enter a valid tenant identifier");
  const rows = await sql<{ deleted: boolean }[]>`
    SELECT platform.delete_tenant_for_administrator(
      ${tenantId}::uuid, ${requestId}::text
    ) AS deleted
  `;
  return rows[0]?.deleted === true;
}
