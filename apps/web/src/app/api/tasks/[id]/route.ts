import { NextResponse } from "next/server";

import {
  cancelTask,
  updateTask,
  type TaskInput,
  type TaskPriority,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function optionalString(
  body: Record<string, unknown>,
  key: "title",
): string | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (typeof value === "string") return value;
  throw new TypeError(`${key} must be a string`);
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

function optionalStatus(value: unknown): TaskInput["status"] {
  if (value === undefined) return undefined;
  if (value !== "todo" && value !== "in_progress" && value !== "completed")
    throw new TypeError("task status must be todo, in_progress, or completed");
  return value;
}

function optionalPriority(value: unknown): TaskPriority | undefined {
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

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/tasks/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    if (!uuidPattern.test(id)) throw new TypeError("invalid task identifier");
    const body = await jsonObject(request);
    const title = optionalString(body, "title");
    const description = nullableString(body, "description");
    const status = optionalStatus(body.status);
    const priority = optionalPriority(body.priority);
    const assigneeUserId = nullableString(body, "assigneeUserId");
    const dueAt = nullableString(body, "dueAt");
    const task = await withCurrentTenant("crm:write", (sql) =>
      updateTask(sql, id, {
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(status === undefined ? {} : { status }),
        ...(priority === undefined ? {} : { priority }),
        ...(assigneeUserId === undefined ? {} : { assigneeUserId }),
        ...(dueAt === undefined ? {} : { dueAt }),
      }),
    );
    return task === undefined
      ? NextResponse.json({ error: "Not found" }, { status: 404 })
      : NextResponse.json({ task });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/tasks/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    if (!uuidPattern.test(id)) throw new TypeError("invalid task identifier");
    const task = await withCurrentTenant("crm:write", (sql) =>
      cancelTask(sql, id),
    );
    return task === undefined
      ? NextResponse.json({ error: "Not found" }, { status: 404 })
      : NextResponse.json({ task });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
