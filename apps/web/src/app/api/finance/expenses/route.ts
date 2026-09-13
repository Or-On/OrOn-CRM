import { NextResponse } from "next/server";

import {
  createExpense,
  listExpensePage,
  type ExpenseInput,
  type ExpenseStatus,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function listLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d{1,3}$/u.test(value))
    throw new TypeError("invalid expense page size");
  const parsed = Number(value);
  if (parsed < 1 || parsed > 500)
    throw new TypeError("expense page size must be 1 to 500");
  return parsed;
}

function listStatus(value: string | null): ExpenseStatus | undefined {
  if (value === null) return undefined;
  if (value !== "pending" && value !== "recorded" && value !== "void")
    throw new TypeError("invalid expense status");
  return value;
}

function nullableString(
  body: Record<string, unknown>,
  key: "vendor" | "notes",
): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null || typeof value === "string") return value;
  throw new TypeError(`${key} must be a string or null`);
}

function editableStatus(value: unknown): ExpenseInput["status"] {
  if (value === undefined) return undefined;
  if (value !== "pending" && value !== "recorded")
    throw new TypeError("expense status must be pending or recorded");
  return value;
}

export async function GET(request: Request) {
  try {
    const parameters = new URL(request.url).searchParams;
    const limit = listLimit(parameters.get("limit"));
    const status = listStatus(parameters.get("status"));
    const cursorAt = parameters.get("cursorAt");
    const cursorId = parameters.get("cursorId");
    if ((cursorAt === null) !== (cursorId === null))
      throw new TypeError(
        "expense cursorAt and cursorId must be provided together",
      );
    if (cursorId !== null && !uuidPattern.test(cursorId))
      throw new TypeError("invalid expense cursor identifier");
    const page = await withCurrentTenant("tenant:manage", (sql) =>
      listExpensePage(sql, {
        ...(parameters.get("q") === null
          ? {}
          : { query: parameters.get("q") ?? "" }),
        ...(status === undefined ? {} : { status }),
        ...(parameters.get("category") === null
          ? {}
          : { category: parameters.get("category") ?? "" }),
        ...(limit === undefined ? {} : { limit }),
        ...(cursorAt === null || cursorId === null
          ? {}
          : { cursor: { incurredAt: cursorAt, id: cursorId } }),
      }),
    );
    return NextResponse.json(page);
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (
      typeof body.title !== "string" ||
      typeof body.category !== "string" ||
      typeof body.amount !== "string" ||
      typeof body.currency !== "string" ||
      typeof body.incurredAt !== "string"
    ) {
      throw new TypeError(
        "expense title, category, decimal amount, currency, and incurredAt are required",
      );
    }
    const vendor = nullableString(body, "vendor");
    const notes = nullableString(body, "notes");
    const status = editableStatus(body.status);
    const expense = await withCurrentTenant("tenant:manage", (sql, session) =>
      createExpense(sql, session.userId, {
        title: body.title as string,
        category: body.category as string,
        amount: body.amount as string,
        currency: body.currency as string,
        incurredAt: body.incurredAt as string,
        ...(vendor === undefined ? {} : { vendor }),
        ...(notes === undefined ? {} : { notes }),
        ...(status === undefined ? {} : { status }),
      }),
    );
    return NextResponse.json({ expense }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
