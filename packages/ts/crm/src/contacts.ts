import type postgres from "postgres";

import { normalizeE164 } from "./phone.js";
import type {
  ContactCustomField,
  ContactDetail,
  ContactImportResult,
  ContactImportRow,
  ContactInput,
  ContactNote,
  ContactSummary,
  JsonValue,
  Tag,
} from "./types.js";

interface ContactRow {
  id: string;
  name: string;
  email: string | null;
  company: string | null;
  lifecycle_status: ContactSummary["lifecycleStatus"];
  voice_consent: ContactSummary["voiceConsent"];
  whatsapp_consent: ContactSummary["whatsAppConsent"];
  whatsapp_opted_out_at: Date | null;
  last_activity_at: Date | null;
  created_at: Date;
  identities: unknown;
  tags: unknown;
  classifications: unknown;
  sort_at: Date;
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
    voiceConsent: row.voice_consent,
    whatsAppConsent: row.whatsapp_consent,
    whatsAppOptedOutAt: row.whatsapp_opted_out_at?.toISOString() ?? null,
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
    classifications: safeArray(row.classifications).flatMap((classification) =>
      typeof classification.id === "string" &&
      typeof classification.name === "string" &&
      typeof classification.color === "string"
        ? [
            {
              id: classification.id,
              name: classification.name,
              color: classification.color,
            },
          ]
        : [],
    ),
  };
}

const contactProjection = `
  SELECT c.id, c.name, c.email, c.company, c.lifecycle_status, c.voice_consent,
         c.whatsapp_consent, c.whatsapp_opted_out_at,
         c.last_activity_at, c.created_at,
         COALESCE(c.last_activity_at, c.created_at) AS sort_at,
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
           WHERE ct.contact_id = c.id), '[]') AS tags,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
           'id', classification.id, 'name', classification.name,
           'color', classification.color) ORDER BY lower(classification.name))
           FROM crm.contact_classifications assignment
           JOIN crm.customer_classifications classification
             ON classification.id = assignment.classification_id
           WHERE assignment.contact_id = c.id AND classification.active), '[]')
           AS classifications
  FROM crm.contacts c
`;

export async function listContacts(
  sql: postgres.TransactionSql,
  options: { readonly query?: string; readonly limit?: number } = {},
): Promise<readonly ContactSummary[]> {
  return (await listContactPage(sql, options)).contacts;
}

export interface ContactCursor {
  readonly sortAt: string;
  readonly id: string;
}

export interface ContactPage {
  readonly contacts: readonly ContactSummary[];
  readonly nextCursor: ContactCursor | null;
}

export async function listContactPage(
  sql: postgres.TransactionSql,
  options: {
    readonly query?: string;
    readonly limit?: number;
    readonly cursor?: ContactCursor;
  } = {},
): Promise<ContactPage> {
  const query = options.query?.trim() ?? "";
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const cursorDate =
    options.cursor === undefined ? undefined : new Date(options.cursor.sortAt);
  if (cursorDate !== undefined && Number.isNaN(cursorDate.valueOf()))
    throw new TypeError("Contact cursor timestamp is invalid");
  const rows = await sql.unsafe<ContactRow[]>(
    `${contactProjection}
     WHERE c.lifecycle_status <> 'archived'
       AND ($1 = '' OR c.name ILIKE '%' || $1 || '%' OR
            COALESCE(c.email, '') ILIKE '%' || $1 || '%' OR
             COALESCE(c.company, '') ILIKE '%' || $1 || '%' OR
             EXISTS (SELECT 1 FROM crm.contact_channel_identities ci
                     WHERE ci.contact_id = c.id AND ci.normalized_value ILIKE '%' || $1 || '%'))
       AND ($3::timestamptz IS NULL OR
         (COALESCE(c.last_activity_at, c.created_at), c.id) <
         ($3::timestamptz, $4::uuid))
     ORDER BY COALESCE(c.last_activity_at, c.created_at) DESC, c.id DESC
     LIMIT $2`,
    [
      query,
      limit + 1,
      cursorDate?.toISOString() ?? null,
      options.cursor?.id ?? null,
    ],
  );
  const hasMore = rows.length > limit;
  const selected = hasMore ? rows.slice(0, limit) : rows;
  const last = selected.at(-1);
  return {
    contacts: selected.map(mapContact),
    nextCursor:
      hasMore && last !== undefined
        ? { sortAt: last.sort_at.toISOString(), id: last.id }
        : null,
  };
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
  actorUserId: string | null,
  input: ContactInput,
  options: { readonly grantChannelConsent?: boolean } = {},
): Promise<ContactSummary> {
  const name = input.name.trim();
  if (name === "") throw new TypeError("contact name is required");
  const phone =
    input.phone === undefined ? undefined : normalizeE164(input.phone);
  if (input.phone !== undefined && phone === undefined)
    throw new TypeError("phone must be explicit E.164");
  const email = input.email?.trim();
  const company = input.company?.trim();

  // Channel-specific uniqueness is insufficient: an existing phone identity must
  // not acquire a new, granted WhatsApp contact through manual or API creation.
  if (await contactRecipientExists(sql, phone, email))
    throw Object.assign(new Error("A matching record already exists"), {
      code: "23505",
    });

  // Current tenant product policy grants permission only at creation. Never use
  // this INSERT policy to rewrite existing unknown, revoked, or opted-out records.
  const rows = await sql<{ id: string }[]>`
    INSERT INTO crm.contacts
      (tenant_id, created_by_user_id, name, email, company, voice_consent, whatsapp_consent)
    VALUES (platform.current_tenant_id(), ${actorUserId}::uuid, ${name},
            ${email === undefined || email === "" ? null : email},
            ${company === undefined || company === "" ? null : company},
            ${options.grantChannelConsent === false ? "unknown" : "granted"},
            ${options.grantChannelConsent === false ? "unknown" : "granted"})
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

async function contactRecipientExists(
  sql: postgres.TransactionSql,
  phone: string | undefined,
  email: string | undefined,
): Promise<boolean> {
  const candidateEmail = email?.trim().toLowerCase();
  const normalizedEmail =
    candidateEmail === undefined || candidateEmail === ""
      ? null
      : candidateEmail;
  const duplicates = await sql<{ found: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM crm.contacts contact
      WHERE (${normalizedEmail}::text IS NOT NULL AND lower(contact.email) = ${normalizedEmail})
      UNION ALL
      SELECT 1 FROM crm.contact_channel_identities identity
      WHERE (${phone ?? null}::text IS NOT NULL AND identity.channel IN ('phone', 'whatsapp')
             AND identity.normalized_value = ${phone ?? null})
         OR (${normalizedEmail}::text IS NOT NULL AND identity.channel = 'email'
             AND lower(identity.normalized_value) = ${normalizedEmail})
    ) AS found
  `;
  // No lifecycle or permission predicate: archived/revoked/opted-out records
  // remain matches. Tenant RLS scopes every lookup without disclosing other tenants.
  return duplicates[0]?.found === true;
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

export async function getContactDetail(
  sql: postgres.TransactionSql,
  contactId: string,
): Promise<ContactDetail | undefined> {
  const contact = await getContact(sql, contactId);
  if (contact === undefined) return undefined;
  const notes = await sql<
    {
      id: string;
      author_user_id: string | null;
      body: string;
      created_at: Date;
    }[]
  >`
    SELECT id, author_user_id, body, created_at FROM crm.notes
    WHERE contact_id = ${contactId}::uuid
    ORDER BY created_at DESC, id DESC LIMIT 100
  `;
  const customFields = await sql<
    {
      id: string;
      key: string;
      label: string;
      field_type: ContactCustomField["fieldType"];
      value: JsonValue | null;
    }[]
  >`
    SELECT definition.id, definition.key, definition.label,
           definition.field_type, value.value
    FROM crm.custom_field_definitions definition
    LEFT JOIN crm.contact_custom_field_values value
      ON value.field_id = definition.id AND value.contact_id = ${contactId}::uuid
    ORDER BY lower(definition.label), definition.id
  `;
  return {
    ...contact,
    notes: notes.map((note): ContactNote => ({
      id: note.id,
      authorUserId: note.author_user_id,
      body: note.body,
      createdAt: note.created_at.toISOString(),
    })),
    customFields: customFields.map((field) => ({
      id: field.id,
      key: field.key,
      label: field.label,
      fieldType: field.field_type,
      value: field.value,
    })),
  };
}

export async function updateContact(
  sql: postgres.TransactionSql,
  contactId: string,
  input: Partial<Pick<ContactInput, "name" | "email" | "company">>,
): Promise<ContactSummary | undefined> {
  const name = input.name?.trim();
  if (input.name !== undefined && name === "")
    throw new TypeError("contact name is required");
  const email = input.email?.trim() ?? null;
  const company = input.company?.trim() ?? null;
  const rows = await sql<{ id: string }[]>`
    UPDATE crm.contacts
    SET name = CASE WHEN ${input.name !== undefined} THEN ${name ?? ""} ELSE name END,
        email = CASE WHEN ${input.email !== undefined} THEN ${email === "" ? null : email} ELSE email END,
        company = CASE WHEN ${input.company !== undefined} THEN ${company === "" ? null : company} ELSE company END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${contactId}::uuid
    RETURNING id
  `;
  return rows.length === 0 ? undefined : getContact(sql, contactId);
}

export async function setVoiceConsent(
  sql: postgres.TransactionSql,
  contactId: string,
  consent: ContactSummary["voiceConsent"],
): Promise<ContactSummary | undefined> {
  const rows = await sql<{ id: string }[]>`
    UPDATE crm.contacts
    SET voice_consent = ${consent}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${contactId}::uuid
    RETURNING id
  `;
  return rows.length === 0 ? undefined : getContact(sql, contactId);
}

export async function addContactNote(
  sql: postgres.TransactionSql,
  contactId: string,
  authorUserId: string,
  body: string,
): Promise<ContactNote> {
  const normalized = body.trim();
  if (normalized === "" || normalized.length > 10_000)
    throw new TypeError("note must contain between 1 and 10000 characters");
  const rows = await sql<
    {
      id: string;
      author_user_id: string | null;
      body: string;
      created_at: Date;
    }[]
  >`
    INSERT INTO crm.notes (tenant_id, contact_id, author_user_id, body)
    VALUES (platform.current_tenant_id(), ${contactId}::uuid,
            ${authorUserId}::uuid, ${normalized})
    RETURNING id, author_user_id, body, created_at
  `;
  const note = rows[0];
  if (note === undefined) throw new Error("note insert returned no row");
  return {
    id: note.id,
    authorUserId: note.author_user_id,
    body: note.body,
    createdAt: note.created_at.toISOString(),
  };
}

export async function setContactCustomField(
  sql: postgres.TransactionSql,
  contactId: string,
  fieldId: string,
  value: JsonValue,
): Promise<void> {
  await sql`
    INSERT INTO crm.contact_custom_field_values
      (tenant_id, contact_id, field_id, value)
    VALUES (platform.current_tenant_id(), ${contactId}::uuid,
            ${fieldId}::uuid, ${sql.json(value)})
    ON CONFLICT (tenant_id, contact_id, field_id)
    DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
  `;
}

export async function listTags(
  sql: postgres.TransactionSql,
): Promise<readonly Tag[]> {
  return sql<Tag[]>`
    SELECT id, name, color FROM crm.tags ORDER BY lower(name), id
  `;
}

export async function importContacts(
  sql: postgres.TransactionSql,
  actorUserId: string,
  rows: readonly ContactImportRow[],
): Promise<ContactImportResult> {
  if (rows.length > 1_000)
    throw new TypeError("contact import is limited to 1000 rows");
  let created = 0;
  let skipped = 0;
  const errors: { row: number; reason: string }[] = [];
  for (const [index, row] of rows.entries()) {
    try {
      // PostgreSQL errors abort a transaction until rollback. Recover each row
      // at a savepoint before continuing, and count only released row work.
      const outcome = await sql.savepoint(async (rowSql) => {
        const phone =
          row.phone === undefined ? undefined : normalizeE164(row.phone);
        if (row.phone !== undefined && phone === undefined)
          throw new TypeError("phone must be explicit E.164");
        if (await contactRecipientExists(rowSql, phone, row.email))
          return "skipped";
        await createContact(rowSql, actorUserId, row);
        return "created";
      });
      if (outcome === "created") created += 1;
      else skipped += 1;
    } catch (error) {
      const reason = importRowError(error);
      // Outages, access failures, deadlocks and unexpected defects fail the
      // whole import; they must never look like a successful partial import.
      if (reason === undefined) throw error;
      errors.push({
        row: index + 2,
        reason,
      });
    }
  }
  return { created, skipped, errors };
}

function importRowError(error: unknown): string | undefined {
  if (
    error instanceof TypeError &&
    (error.message === "phone must be explicit E.164" ||
      error.message === "contact name is required")
  )
    return error.message;
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (code === "23505") return "A matching contact already exists";
  if (code === "23503") return "Related contact data was not found";
  if (
    code === "23502" ||
    code === "23514" ||
    code === "22001" ||
    code === "22021" ||
    code === "22P02"
  )
    return "Contact data is invalid";
  return undefined;
}
