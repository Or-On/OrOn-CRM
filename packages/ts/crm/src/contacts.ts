import type postgres from "postgres";

import { normalizeE164 } from "./phone.js";
import type { ContactInput, ContactSummary } from "./types.js";

interface ContactRow {
  id: string;
  name: string;
  email: string | null;
  company: string | null;
  lifecycle_status: ContactSummary["lifecycleStatus"];
  last_activity_at: Date | null;
  created_at: Date;
  identities: unknown;
  tags: unknown;
}

function safeArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object",
      )
    : [];
}

function mapContact(row: ContactRow): ContactSummary {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    company: row.company,
    lifecycleStatus: row.lifecycle_status,
    lastActivityAt: row.last_activity_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    identities: safeArray(row.identities).flatMap((identity) =>
      typeof identity.id === "string" &&
      typeof identity.channel === "string" &&
      typeof identity.validation_status === "string"
        ? [
            {
              id: identity.id,
              channel:
                identity.channel as ContactSummary["identities"][number]["channel"],
              normalizedValue:
                typeof identity.normalized_value === "string"
                  ? identity.normalized_value
                  : null,
              displayValue:
                typeof identity.display_value === "string"
                  ? identity.display_value
                  : null,
              validationStatus:
                identity.validation_status as ContactSummary["identities"][number]["validationStatus"],
              isPrimary: identity.is_primary === true,
            },
          ]
        : [],
    ),
    tags: safeArray(row.tags).flatMap((tag) =>
      typeof tag.id === "string" &&
      typeof tag.name === "string" &&
      typeof tag.color === "string"
        ? [{ id: tag.id, name: tag.name, color: tag.color }]
        : [],
    ),
  };
}

const contactProjection = `
  SELECT c.id, c.name, c.email, c.company, c.lifecycle_status,
         c.last_activity_at, c.created_at,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
           'id', i.id, 'channel', i.channel,
           'normalized_value', i.normalized_value,
           'display_value', i.display_value,
           'validation_status', i.validation_status,
           'is_primary', i.is_primary) ORDER BY i.created_at)
           FROM crm.contact_channel_identities i WHERE i.contact_id = c.id), '[]') AS identities,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
           'id', t.id, 'name', t.name, 'color', t.color) ORDER BY lower(t.name))
           FROM crm.contact_tags ct JOIN crm.tags t ON t.id = ct.tag_id
           WHERE ct.contact_id = c.id), '[]') AS tags
  FROM crm.contacts c
`;

export async function listContacts(
  sql: postgres.TransactionSql,
  options: { readonly query?: string; readonly limit?: number } = {},
): Promise<readonly ContactSummary[]> {
  const query = options.query?.trim() ?? "";
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const rows = await sql.unsafe<ContactRow[]>(
    `${contactProjection}
     WHERE c.lifecycle_status <> 'archived'
       AND ($1 = '' OR c.name ILIKE '%' || $1 || '%' OR
            COALESCE(c.email, '') ILIKE '%' || $1 || '%' OR
            COALESCE(c.company, '') ILIKE '%' || $1 || '%' OR
            EXISTS (SELECT 1 FROM crm.contact_channel_identities ci
                    WHERE ci.contact_id = c.id AND ci.normalized_value ILIKE '%' || $1 || '%'))
     ORDER BY COALESCE(c.last_activity_at, c.created_at) DESC, c.id DESC
     LIMIT $2`,
    [query, limit],
  );
  return rows.map(mapContact);
}

export async function getContact(
  sql: postgres.TransactionSql,
  contactId: string,
): Promise<ContactSummary | undefined> {
  const rows = await sql.unsafe<ContactRow[]>(
    `${contactProjection} WHERE c.id = $1::uuid`,
    [contactId],
  );
  return rows[0] === undefined ? undefined : mapContact(rows[0]);
}

export async function createContact(
  sql: postgres.TransactionSql,
  actorUserId: string,
  input: ContactInput,
): Promise<ContactSummary> {
  const name = input.name.trim();
  if (name === "") throw new TypeError("contact name is required");
  const phone =
    input.phone === undefined ? undefined : normalizeE164(input.phone);
  if (input.phone !== undefined && phone === undefined)
    throw new TypeError("phone must be explicit E.164");
  const email = input.email?.trim();
  const company = input.company?.trim();

  const rows = await sql<{ id: string }[]>`
    INSERT INTO crm.contacts (tenant_id, created_by_user_id, name, email, company)
    VALUES (platform.current_tenant_id(), ${actorUserId}::uuid, ${name},
            ${email === undefined || email === "" ? null : email},
            ${company === undefined || company === "" ? null : company})
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (id === undefined)
    throw new Error("contact insert returned no identifier");
  if (phone !== undefined) {
    await sql`
      INSERT INTO crm.contact_channel_identities
        (tenant_id, contact_id, channel, normalized_value, display_value,
         validation_status, is_primary, provider)
      VALUES (platform.current_tenant_id(), ${id}::uuid, 'whatsapp', ${phone},
              ${input.phone ?? phone}, 'valid', true, 'simulator')
    `;
  }
  for (const tagId of new Set(input.tagIds ?? [])) {
    await sql`
      INSERT INTO crm.contact_tags (tenant_id, contact_id, tag_id)
      VALUES (platform.current_tenant_id(), ${id}::uuid, ${tagId}::uuid)
      ON CONFLICT DO NOTHING
    `;
  }
  const contact = await getContact(sql, id);
  if (contact === undefined)
    throw new Error("created contact could not be read");
  return contact;
}

export async function archiveContact(
  sql: postgres.TransactionSql,
  contactId: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE crm.contacts SET lifecycle_status = 'archived', updated_at = CURRENT_TIMESTAMP
    WHERE id = ${contactId}::uuid AND lifecycle_status <> 'archived'
    RETURNING id
  `;
  return rows.length === 1;
}
