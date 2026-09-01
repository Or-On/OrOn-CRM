import type postgres from "postgres";

import type { Deal, PipelineBoard, PipelineStage } from "./types.js";

interface PipelineRow {
  id: string;
  name: string;
}

interface StageRow {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
  probability: number;
}

interface DealRow {
  id: string;
  pipeline_id: string;
  stage_id: string;
  contact_id: string | null;
  contact_name: string | null;
  title: string;
  value: string;
  currency: string;
  status: Deal["status"];
  updated_at: Date;
}

export async function listPipelineBoards(
  sql: postgres.TransactionSql,
): Promise<readonly PipelineBoard[]> {
  const pipelines = await sql<PipelineRow[]>`
    SELECT id, name FROM crm.pipelines ORDER BY is_default DESC, name
  `;
  const stages = await sql<StageRow[]>`
    SELECT id, pipeline_id, name, position, probability
    FROM crm.pipeline_stages ORDER BY pipeline_id, position
  `;
  const deals = await sql<DealRow[]>`
    SELECT d.id, d.pipeline_id, d.stage_id, d.contact_id,
           c.name AS contact_name, d.title, d.value::text, d.currency,
           d.status, d.updated_at
    FROM crm.deals d LEFT JOIN crm.contacts c ON c.id = d.contact_id
    WHERE d.status <> 'archived'
    ORDER BY d.updated_at DESC, d.id DESC
  `;
  const mapStage = (row: StageRow): PipelineStage => ({
    id: row.id,
    pipelineId: row.pipeline_id,
    name: row.name,
    position: row.position,
    probability: row.probability,
  });
  const mapDeal = (row: DealRow): Deal => ({
    id: row.id,
    pipelineId: row.pipeline_id,
    stageId: row.stage_id,
    contactId: row.contact_id,
    contactName: row.contact_name,
    title: row.title,
    value: row.value,
    currency: row.currency,
    status: row.status,
    updatedAt: row.updated_at.toISOString(),
  });
  return pipelines.map((pipeline) => ({
    id: pipeline.id,
    name: pipeline.name,
    stages: stages
      .filter((stage) => stage.pipeline_id === pipeline.id)
      .map(mapStage),
    deals: deals
      .filter((deal) => deal.pipeline_id === pipeline.id)
      .map(mapDeal),
  }));
}

export async function moveDeal(
  sql: postgres.TransactionSql,
  dealId: string,
  stageId: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE crm.deals d SET stage_id = s.id, updated_at = CURRENT_TIMESTAMP
    FROM crm.pipeline_stages s
    WHERE d.id = ${dealId}::uuid AND s.id = ${stageId}::uuid
      AND s.pipeline_id = d.pipeline_id AND s.tenant_id = d.tenant_id
    RETURNING d.id
  `;
  return rows.length === 1;
}
