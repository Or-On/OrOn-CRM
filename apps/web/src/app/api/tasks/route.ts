import { NextResponse } from "next/server";

import {
  createTask,
  listTasks,
  type TaskInput,
  type TaskPriority,
  type TaskStatus,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../features/crm-route";

function listLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d{1,3}$/u.test(value)) throw new TypeError("invalid task page size");
  const parsed = Number(value);
  if (parsed < 1 || parsed > 500)
    throw new TypeError("task page size must be 1 to 500");
  return parsed;
}

function listStatus(value: string | null): TaskStatus | undefined {
  if (value === null) return undefined;
  if (
    value !== "todo" &&
    value !== "in_progress" &&
    value !== "completed" &&
    value !== "cancelled"
  )
    throw new TypeError("invalid task status");
  return value;
}

function listPriority(value: string | null): TaskPriority | undefined {
  if (value === null) return undefined;
  if (
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "urgent"
  )
    throw new TypeError("invalid task priority");
  return value;
}

function nullableString(
  body: Record<string, unknown>,
  key: "description" | "assigneeUserId" | "dueAt",
): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null || typeof value === "string") return value;
  throw new TypeError(`${key} must be a string or null`);
}

function editableStatus(value: unknown): TaskInput["status"] {
  if (value === undefined) return undefined;
  if (value !== "todo" && value !== "in_progress" && value !== "completed")
    throw new TypeError("task status must be todo, in_progress, or completed");
  return value;
}

function editablePriority(value: unknown): TaskPriority | undefined {
  if (value === undefined) return undefined;
  if (
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "urgent"
  )
    throw new TypeError("invalid task priority");
  return value;
}

export async function GET(request: Request) {
  try {
    const parameters = new URL(request.url).searchParams;
    const status = listStatus(parameters.get("status"));
    const priority = listPriority(parameters.get("priority"));
    const limit = listLimit(parameters.get("limit"));
    const tasks = await withCurrentTenant("crm:read", (sql) =>
      listTasks(sql, {
        ...(parameters.get("q") === null
          ? {}
          : { query: parameters.get("q") ?? "" }),
        ...(status === undefined ? {} : { status }),
        ...(priority === undefined ? {} : { priority }),
        ...(parameters.get("assigneeUserId") === null
          ? {}
          : { assigneeUserId: parameters.get("assigneeUserId") ?? "" }),
        ...(limit === undefined ? {} : { limit }),
      }),
    );
    return NextResponse.json({ tasks });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (typeof body.title !== "string")
      throw new TypeError("task title is required");
    const description = nullableString(body, "description");
    const status = editableStatus(body.status);
    const priority = editablePriority(body.priority);
    const assigneeUserId = nullableString(body, "assigneeUserId");
    const dueAt = nullableString(body, "dueAt");
    const task = await withCurrentTenant("crm:write", (sql, session) =>
      createTask(sql, session.userId, {
        title: body.title as string,
        ...(description === undefined ? {} : { description }),
        ...(status === undefined ? {} : { status }),
        ...(priority === undefined ? {} : { priority }),
        ...(assigneeUserId === undefined ? {} : { assigneeUserId }),
        ...(dueAt === undefined ? {} : { dueAt }),
      }),
    );
    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
