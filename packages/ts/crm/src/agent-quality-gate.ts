import type postgres from "postgres";
import { qualityId, qualityObject } from "./agent-quality.js";
import { assertKnowledgeManager } from "./knowledge.js";
import { requireTenantFeature } from "./tenant-features.js";

export type AgentGoldenState =
  "blocked" | "pending" | "running" | "failed" | "passed" | "stale";

/** Server-produced status only. Browser inputs never contain evaluation scores. */
export interface AgentGoldenEvaluationStatus {
  readonly id: string;
  readonly datasetId: string;
  readonly state: AgentGoldenState;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly expiresAt: string;
  readonly hasAcceptedReceipt: boolean;
}

export interface ApprovedAgentGoldenDataset {
  readonly id: string;
  readonly digest: string;
  readonly rubricVersion: string;
  readonly approvedAt: string;
}

export interface AgentGoldenWorkspace {
  readonly enabled: boolean;
  readonly datasets: readonly ApprovedAgentGoldenDataset[];
  readonly evaluations: readonly AgentGoldenEvaluationStatus[];
}

/** Existing mutation routes render these localized requirements with HTTP 422. */
export class AgentGoldenEvidenceRequiredError extends Error {
  override readonly name = "FieldWorkflowRequirementError";
  readonly code = "AGENT_GOLDEN_EVIDENCE_REQUIRED";
  readonly messages = {
    en: "This version needs a current passing evaluation using the approved real conversation set and model before publication.",
    he: "לפני פרסום הגרסה נדרשת בדיקה עדכנית שעברה בהצלחה עם סט השיחות האמיתיות והמודל שאושרו.",
  };
  constructor() {
    super("Current approved real conversation quality evidence is required");
  }
}

const states = new Set<unknown>([
  "blocked",
  "pending",
  "running",
  "failed",
  "passed",
  "stale",
]);

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new TypeError("invalid server golden evaluation timestamp");
  return value;
}

export function parseAgentGoldenEvaluationStatuses(
  value: unknown,
): readonly AgentGoldenEvaluationStatus[] {
  if (!Array.isArray(value) || value.length > 50)
    throw new TypeError("invalid bounded server golden evaluation status");
  return value.map((entry: unknown) => {
    const row = qualityObject(entry);
    if (!states.has(row.state) || typeof row.hasAcceptedReceipt !== "boolean")
      throw new TypeError("invalid server golden evaluation state");
    if (row.hasAcceptedReceipt && row.state !== "passed")
      throw new TypeError("inconsistent accepted golden receipt state");
    return {
      id: qualityId(row.id),
      datasetId: qualityId(row.datasetId),
      state: row.state as AgentGoldenState,
      createdAt: timestamp(row.createdAt),
      completedAt: row.completedAt === null ? null : timestamp(row.completedAt),
      expiresAt: timestamp(row.expiresAt),
      hasAcceptedReceipt: row.hasAcceptedReceipt,
    };
  });
}

async function assertVersionBinding(
  sql: postgres.TransactionSql,
  profileId: unknown,
  versionId: unknown,
): Promise<string> {
  await requireTenantFeature(sql, "agents");
  await assertKnowledgeManager(sql);
  const profile = qualityId(profileId);
  const version = qualityId(versionId);
  const rows = await sql<{ id: string }[]>`
    SELECT version.id FROM agents.agent_profile_versions version
    JOIN agents.agent_profiles profile ON profile.id=version.agent_profile_id
      AND profile.tenant_id=version.tenant_id AND profile.archived_at IS NULL
    WHERE version.id=${version}::uuid AND version.agent_profile_id=${profile}::uuid
      AND version.tenant_id=platform.current_tenant_id()
  `;
  if (rows[0]?.id !== version)
    throw Object.assign(new Error("Agent version unavailable"), {
      code: "42501",
    });
  return version;
}

/** Requires the prepared ea migration; do not wire before its reviewed deployment. */
export async function requestAgentGoldenEvaluation(
  sql: postgres.TransactionSql,
  profileId: unknown,
  input: unknown,
): Promise<string> {
  const row = qualityObject(input);
  // Scores/receipts/policy/provenance cannot be supplied through this operation.
  if (
    Object.keys(row).some((key) => key !== "versionId" && key !== "datasetId")
  )
    throw new TypeError(
      "golden request accepts version and dataset identifiers only",
    );
  const version = await assertVersionBinding(sql, profileId, row.versionId);
  const dataset = qualityId(row.datasetId);
  const rows = await sql<{ id: string }[]>`
    SELECT platform.request_agent_quality_evaluation(${version}::uuid,${dataset}::uuid,'manual') AS id
  `;
  return qualityId(rows[0]?.id);
}

export async function listAgentGoldenEvaluations(
  sql: postgres.TransactionSql,
  profileId: unknown,
  versionId: unknown,
): Promise<readonly AgentGoldenEvaluationStatus[]> {
  const version = await assertVersionBinding(sql, profileId, versionId);
  const rows = await sql<{ result: unknown }[]>`
    SELECT platform.list_agent_quality_evaluations(${version}::uuid) AS result
  `;
  return parseAgentGoldenEvaluationStatuses(rows[0]?.result);
}

export async function getAgentGoldenWorkspace(
  sql: postgres.TransactionSql,
  profileId: unknown,
  versionId: unknown,
): Promise<AgentGoldenWorkspace> {
  const version = await assertVersionBinding(sql, profileId, versionId);
  const gates = await sql<{ enabled: boolean }[]>`
    SELECT platform.current_agent_quality_gate_enabled() AS enabled
  `;
  if (gates[0]?.enabled !== true)
    return { enabled: false, datasets: [], evaluations: [] };
  const rows = await sql<{ result: unknown }[]>`
    SELECT platform.list_approved_agent_quality_datasets(${qualityId(profileId)}::uuid) AS result
  `;
  const result = rows[0]?.result;
  if (!Array.isArray(result) || result.length > 50)
    throw new TypeError("invalid server approved dataset list");
  const datasets = result.map((entry: unknown): ApprovedAgentGoldenDataset => {
    const row = qualityObject(entry);
    if (
      typeof row.digest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(row.digest) ||
      typeof row.rubricVersion !== "string" ||
      row.rubricVersion.length === 0 ||
      row.rubricVersion.length > 100
    )
      throw new TypeError("invalid server approved dataset revision");
    return {
      id: qualityId(row.id),
      digest: row.digest,
      rubricVersion: row.rubricVersion,
      approvedAt: timestamp(row.approvedAt),
    };
  });
  return {
    enabled: true,
    datasets,
    evaluations: await listAgentGoldenEvaluations(sql, profileId, version),
  };
}

/** Call inside the publication transaction after existing permission/knowledge checks. */
export async function assertAgentGoldenPublishable(
  sql: postgres.TransactionSql,
  versionId: unknown,
): Promise<void> {
  const version = qualityId(versionId);
  try {
    await sql`SELECT platform.assert_agent_quality_publishable(${version}::uuid)`;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "55000"
    )
      throw new AgentGoldenEvidenceRequiredError();
    throw error;
  }
}
