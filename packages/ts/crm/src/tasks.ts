import type postgres from "postgres";

import type { Task, TaskInput, TaskPriority, TaskStatus } from "./types.js";

interface TaskRow {
  id: string;
  created_by_user_id: string | null;
  assignee_user_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TaskListOptions {
  readonly query?: string;
  readonly status?: TaskStatus;
  readonly priority?: TaskPriority;
  readonly assigneeUserId?: string;
  readonly limit?: number;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requiredText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum)
    throw new TypeError(
      `${name} must contain between 1 and ${String(maximum)} characters`,
    );
  return normalized;
}

function nullableText(
  value: string | null | undefined,
  name: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (normalized.length > maximum)
    throw new TypeError(
      `${name} must contain no more than ${String(maximum)} characters`,
    );
  return normalized;
}

function editableStatus(value: string): Exclude<TaskStatus, "cancelled"> {
  if (value !== "todo" && value !== "in_progress" && value !== "completed")
    throw new TypeError("task status must be todo, in_progress, or completed");
  return value;
}

function priority(value: string): TaskPriority {
  if (
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "urgent"
  )
    throw new TypeError("invalid task priority");
  return value;
}

function optionalInstant(
  value: string | null | undefined,
  name: string,
): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const normalized = value.trim();
  if (
    !/(?:Z|[+-]\d{2}:\d{2})$/u.test(normalized) ||
    !Number.isFinite(Date.parse(normalized))
  ) {
    throw new TypeError(
      `${name} must be an ISO 8601 instant with a time-zone offset`,
    );
  }
  return new Date(normalized).toISOString();
}

function optionalMemberId(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const normalized = value.trim();
  if (!uuidPattern.test(normalized))
    throw new TypeError("invalid task assignee identifier");
  return normalized;
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    createdByUserId: row.created_by_user_id,
    assigneeUserId: row.assignee_user_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    dueAt: row.due_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listTasks(
  sql: postgres.TransactionSql,
  options: TaskListOptions = {},
): Promise<readonly Task[]> {
  const query = options.query?.trim() ?? "";
  if (query.length > 200) throw new TypeError("task search is too long");
  const status: string | null = options.status ?? null;
  if (
    status !== null &&
    status !== "todo" &&
    status !== "in_progress" &&
    status !== "completed" &&
    status !== "cancelled"
  ) {
    throw new TypeError("invalid task status");
  }
  const taskPriority = options.priority ?? null;
  if (taskPriority !== null) priority(taskPriority);
  const assigneeUserId = optionalMemberId(options.assigneeUserId);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
  const rows = await sql<TaskRow[]>`
    SELECT id, created_by_user_id, assignee_user_id, title, description,
      status, priority, due_at, completed_at, created_at, updated_at
    FROM crm.tasks
    WHERE (${query}::text = '' OR title ILIKE '%' || ${query} || '%'
           OR coalesce(description, '') ILIKE '%' || ${query} || '%')
      AND (${status}::text IS NULL OR status = ${status})
      AND (${taskPriority}::text IS NULL OR priority = ${taskPriority})
      AND (${assigneeUserId}::uuid IS NULL OR assignee_user_id = ${assigneeUserId}::uuid)
    ORDER BY due_at ASC NULLS LAST, updated_at DESC, id DESC
    LIMIT ${limit}
  `;
  return rows.map(mapTask);
}

export async function createTask(
  sql: postgres.TransactionSql,
  actorUserId: string | null,
  input: TaskInput,
): Promise<Task> {
  const title = requiredText(input.title, "task title", 240);
  const description = nullableText(
    input.description,
    "task description",
    20_000,
  );
  const status =
    input.status === undefined ? "todo" : editableStatus(input.status);
  const taskPriority =
    input.priority === undefined ? "medium" : priority(input.priority);
  const assigneeUserId = optionalMemberId(input.assigneeUserId);
  const dueAt = optionalInstant(input.dueAt, "dueAt");
  const rows = await sql<TaskRow[]>`
    INSERT INTO crm.tasks(
      tenant_id, created_by_user_id, assignee_user_id, title, description,
      status, priority, due_at, completed_at
    )
    SELECT platform.current_tenant_id(), ${actorUserId}::uuid,
      ${assigneeUserId}::uuid, ${title}, ${description}, ${status}, ${taskPriority},
      ${dueAt}::timestamptz,
      CASE WHEN ${status}::text = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END
    WHERE ${assigneeUserId}::uuid IS NULL OR EXISTS (
      SELECT 1 FROM platform.current_tenant_team() member
      WHERE member.user_id = ${assigneeUserId}::uuid
    )
    RETURNING id, created_by_user_id, assignee_user_id, title, description,
      status, priority, due_at, completed_at, created_at, updated_at
  `;
  const row = rows[0];
  if (row === undefined)
    throw new TypeError("task assignee must be a member of the current tenant");
  return mapTask(row);
}

export async function updateTask(
  sql: postgres.TransactionSql,
  taskId: string,
  input: Partial<TaskInput>,
): Promise<Task | undefined> {
  const changed =
    input.title !== undefined ||
    input.description !== undefined ||
    input.status !== undefined ||
    input.priority !== undefined ||
    input.assigneeUserId !== undefined ||
    input.dueAt !== undefined;
  if (!changed) throw new TypeError("task update contains no changes");
  const title =
    input.title === undefined
      ? null
      : requiredText(input.title, "task title", 240);
  const description =
    input.description === undefined
      ? null
      : nullableText(input.description, "task description", 20_000);
  const status =
    input.status === undefined ? null : editableStatus(input.status);
  const taskPriority =
    input.priority === undefined ? null : priority(input.priority);
  const assigneeUserId =
    input.assigneeUserId === undefined
      ? null
      : optionalMemberId(input.assigneeUserId);
  const dueAt =
    input.dueAt === undefined ? null : optionalInstant(input.dueAt, "dueAt");
  const rows = await sql<TaskRow[]>`
    UPDATE crm.tasks
    SET title = CASE WHEN ${input.title !== undefined} THEN ${title} ELSE title END,
        description = CASE WHEN ${input.description !== undefined}
          THEN ${description} ELSE description END,
        status = CASE WHEN ${input.status !== undefined} THEN ${status} ELSE status END,
        priority = CASE WHEN ${input.priority !== undefined}
          THEN ${taskPriority} ELSE priority END,
        assignee_user_id = CASE WHEN ${input.assigneeUserId !== undefined}
          THEN ${assigneeUserId}::uuid ELSE assignee_user_id END,
        due_at = CASE WHEN ${input.dueAt !== undefined}
          THEN ${dueAt}::timestamptz ELSE due_at END,
        completed_at = CASE
          WHEN ${input.status !== undefined} AND ${status}::text = 'completed'
            THEN coalesce(completed_at, CURRENT_TIMESTAMP)
          WHEN ${input.status !== undefined} THEN NULL
          ELSE completed_at
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${taskId}::uuid AND status <> 'cancelled'
      AND (
        ${input.assigneeUserId === undefined} OR ${assigneeUserId}::uuid IS NULL
        OR EXISTS (
          SELECT 1 FROM platform.current_tenant_team() member
          WHERE member.user_id = ${assigneeUserId}::uuid
        )
      )
    RETURNING id, created_by_user_id, assignee_user_id, title, description,
      status, priority, due_at, completed_at, created_at, updated_at
  `;
  return rows[0] === undefined ? undefined : mapTask(rows[0]);
}

export async function cancelTask(
  sql: postgres.TransactionSql,
  taskId: string,
): Promise<Task | undefined> {
  const rows = await sql<TaskRow[]>`
    UPDATE crm.tasks
    SET status = 'cancelled', completed_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${taskId}::uuid AND status <> 'cancelled'
    RETURNING id, created_by_user_id, assignee_user_id, title, description,
      status, priority, due_at, completed_at, created_at, updated_at
  `;
  return rows[0] === undefined ? undefined : mapTask(rows[0]);
}
