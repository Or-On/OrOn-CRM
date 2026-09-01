import type postgres from "postgres";

import type { AutomationSummary } from "./types.js";

interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  version: number;
  published_at: Date | null;
  validation_status: AutomationSummary["validationStatus"];
  created_at: Date;
}

export async function listAutomations(
  sql: postgres.TransactionSql,
): Promise<readonly AutomationSummary[]> {
  const rows = await sql<AutomationRow[]>`
    SELECT definition.id, definition.name, definition.description,
           version.version, version.published_at, version.validation_status,
           definition.created_at
    FROM automation.flow_definitions definition
    JOIN LATERAL (
      SELECT flow.version, flow.published_at, flow.validation_status
      FROM automation.flow_versions flow
      WHERE flow.flow_definition_id = definition.id
      ORDER BY flow.version DESC LIMIT 1
    ) version ON true
    ORDER BY definition.updated_at DESC, definition.id DESC
  `;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    published: row.published_at !== null,
    validationStatus: row.validation_status,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function createAutomationDraft(
  sql: postgres.TransactionSql,
  actorUserId: string,
  name: string,
  description?: string,
): Promise<string> {
  const normalized = name.trim();
  if (!normalized) throw new TypeError("automation name is required");
  const definitions = await sql<{ id: string }[]>`
    INSERT INTO automation.flow_definitions
      (tenant_id, name, description, channel_capabilities, created_by_user_id)
    VALUES (platform.current_tenant_id(), ${normalized}, ${description?.trim() ?? null},
            ARRAY['whatsapp'], ${actorUserId}::uuid) RETURNING id
  `;
  const id = definitions[0]?.id;
  if (id === undefined)
    throw new Error("automation insert returned no identifier");
  await sql`
    INSERT INTO automation.flow_versions
      (tenant_id, flow_definition_id, version, schema_version, definition,
       validation_status, created_by_user_id)
    VALUES (platform.current_tenant_id(), ${id}::uuid, 1, '1.0',
            ${sql.json({ nodes: [], edges: [], trigger: { type: "manual" } })},
            'valid', ${actorUserId}::uuid)
  `;
  return id;
}

export async function publishAutomation(
  sql: postgres.TransactionSql,
  definitionId: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE automation.flow_versions SET published_at = CURRENT_TIMESTAMP
    WHERE id = (SELECT id FROM automation.flow_versions
                WHERE flow_definition_id = ${definitionId}::uuid
                  AND published_at IS NULL AND validation_status = 'valid'
                ORDER BY version DESC LIMIT 1)
    RETURNING id
  `;
  return rows.length === 1;
}
