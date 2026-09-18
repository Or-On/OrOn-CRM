import type postgres from "postgres";

import type {
  AutomationRunSummary,
  AutomationSummary,
  JsonValue,
} from "./types.js";
import { requireTenantFeature } from "./tenant-features.js";

interface AutomationRow {
  definition: JsonValue;
  execution_kind: NonNullable<AutomationSummary["executionKind"]>;
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
  await requireTenantFeature(sql, "agents");
  const rows = await sql<AutomationRow[]>`
    SELECT definition.id, definition.name, definition.description,
           version.version, version.published_at, version.validation_status,
           definition.created_at, version.definition, version.execution_kind
    FROM automation.flow_definitions definition
    JOIN LATERAL (
      SELECT flow.version, flow.published_at, flow.validation_status, flow.definition,
             CASE WHEN flow.definition->'nodes' = '[]'::jsonb THEN 'empty'
                  WHEN flow.definition->>'schemaVersion' = '1.0' THEN 'canonical'
                  ELSE 'unsupported' END AS execution_kind
      FROM automation.flow_versions flow
      WHERE flow.flow_definition_id = definition.id
      ORDER BY flow.version DESC LIMIT 1
    ) version ON true
    WHERE definition.archived_at IS NULL
    ORDER BY definition.updated_at DESC, definition.id DESC
  `;
  return rows.map((row) => ({
    definition: row.definition,
    executionKind: row.execution_kind,
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    published: row.published_at !== null,
    validationStatus: row.validation_status,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function renameAutomation(
  sql: postgres.TransactionSql,
  actorUserId: string,
  definitionId: string,
  name: string,
): Promise<boolean> {
  await requireTenantFeature(sql, "agents");
  const normalized = name.trim();
  if (!normalized || normalized.length > 120)
    throw new TypeError("flow name must contain 1–120 characters");
  const rows = await sql<{ id: string }[]>`
    UPDATE automation.flow_definitions
    SET name=${normalized}, updated_at=CURRENT_TIMESTAMP
    WHERE id=${definitionId}::uuid AND archived_at IS NULL
    RETURNING id
  `;
  if (rows.length === 1)
    await sql`
      INSERT INTO audit.records
        (tenant_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (platform.current_tenant_id(), ${actorUserId}::uuid,
              'flow.renamed', 'flow_definition', ${definitionId}::uuid,
              ${sql.json({ name: normalized })})
    `;
  return rows.length === 1;
}

export async function archiveAutomation(
  sql: postgres.TransactionSql,
  actorUserId: string,
  definitionId: string,
): Promise<boolean> {
  await requireTenantFeature(sql, "agents");
  const rows = await sql<{ id: string }[]>`
    UPDATE automation.flow_definitions
    SET archived_at=CURRENT_TIMESTAMP,
        name=name || ' · archived ' || left(id::text, 8),
        updated_at=CURRENT_TIMESTAMP
    WHERE id=${definitionId}::uuid AND archived_at IS NULL
    RETURNING id
  `;
  if (rows.length === 1)
    await sql`
      INSERT INTO audit.records
        (tenant_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (platform.current_tenant_id(), ${actorUserId}::uuid,
              'flow.archived', 'flow_definition', ${definitionId}::uuid,
              '{}'::jsonb)
    `;
  return rows.length === 1;
}

export async function createAutomationDraft(
  sql: postgres.TransactionSql,
  actorUserId: string,
  name: string,
  description?: string,
): Promise<string> {
  await requireTenantFeature(sql, "agents");
  await requireTenantFeature(sql, "whatsapp");
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
  await requireTenantFeature(sql, "agents");
  await requireTenantFeature(sql, "whatsapp");
  const rows = await sql<{ id: string }[]>`
    UPDATE automation.flow_versions SET published_at = CURRENT_TIMESTAMP
    WHERE id = (SELECT id FROM automation.flow_versions
                WHERE flow_definition_id = ${definitionId}::uuid
                  AND published_at IS NULL AND validation_status = 'valid'
                  AND definition->'nodes' = '[]'::jsonb
                ORDER BY version DESC LIMIT 1)
    RETURNING id
  `;
  return rows.length === 1;
}

export async function runManualAutomation(
  sql: postgres.TransactionSql,
  definitionId: string,
): Promise<string> {
  await requireTenantFeature(sql, "agents");
  await requireTenantFeature(sql, "whatsapp");
  const rows = await sql<{ id: string }[]>`
    INSERT INTO automation.flow_runs
      (tenant_id, flow_version_id, trigger_type, trigger_metadata, status,
       started_at, completed_at)
    SELECT platform.current_tenant_id(), version.id, 'manual',
           '{"adapter":"phase4-empty-graph"}'::jsonb, 'succeeded',
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM automation.flow_versions version
    JOIN automation.flow_definitions definition
      ON definition.id=version.flow_definition_id
     AND definition.tenant_id=version.tenant_id
     AND definition.archived_at IS NULL
    WHERE version.flow_definition_id = ${definitionId}::uuid
      AND version.published_at IS NOT NULL
      AND version.definition->'nodes' = '[]'::jsonb
    ORDER BY version.version DESC LIMIT 1
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (id === undefined)
    throw new TypeError(
      "use canonical simulation with a conversation for non-empty flows; empty automation must be published",
    );
  return id;
}

export async function listAutomationRuns(
  sql: postgres.TransactionSql,
): Promise<readonly AutomationRunSummary[]> {
  await requireTenantFeature(sql, "agents");
  const rows = await sql<
    {
      id: string;
      definition_id: string;
      status: string;
      started_at: Date | null;
      completed_at: Date | null;
    }[]
  >`
    SELECT run.id, version.flow_definition_id AS definition_id, run.status,
           run.started_at, run.completed_at
    FROM automation.flow_runs run
    JOIN automation.flow_versions version ON version.id = run.flow_version_id
    ORDER BY run.created_at DESC, run.id DESC LIMIT 50
  `;
  return rows.map((row) => ({
    id: row.id,
    definitionId: row.definition_id,
    status: row.status,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  }));
}
