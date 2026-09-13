import { NextResponse } from "next/server";

import { updateExpense, voidExpense, type ExpenseInput } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function optionalString(
  body: Record<string, unknown>,
  key: "title" | "category" | "amount" | "currency" | "incurredAt",
): string | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (typeof value === "string") return value;
  throw new TypeError(`${key} must be a string`);
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

function optionalStatus(value: unknown): ExpenseInput["status"] {
  if (value === undefined) return undefined;
  if (value !== "pending" && value !== "recorded")
    throw new TypeError("expense status must be pending or recorded");
  return value;
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/finance/expenses/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    if (!uuidPattern.test(id))
      throw new TypeError("invalid expense identifier");
    const body = await jsonObject(request);
    const title = optionalString(body, "title");
    const vendor = nullableString(body, "vendor");
    const category = optionalString(body, "category");
    const amount = optionalString(body, "amount");
    const currency = optionalString(body, "currency");
    const status = optionalStatus(body.status);
    const notes = nullableString(body, "notes");
    const incurredAt = optionalString(body, "incurredAt");
    const expense = await withCurrentTenant("tenant:manage", (sql) =>
      updateExpense(sql, id, {
        ...(title === undefined ? {} : { title }),
        ...(vendor === undefined ? {} : { vendor }),
        ...(category === undefined ? {} : { category }),
        ...(amount === undefined ? {} : { amount }),
        ...(currency === undefined ? {} : { currency }),
        ...(status === undefined ? {} : { status }),
        ...(notes === undefined ? {} : { notes }),
        ...(incurredAt === undefined ? {} : { incurredAt }),
      }),
    );
    return expense === undefined
      ? NextResponse.json({ error: "Not found" }, { status: 404 })
      : NextResponse.json({ expense });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/finance/expenses/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    if (!uuidPattern.test(id))
      throw new TypeError("invalid expense identifier");
    const expense = await withCurrentTenant("tenant:manage", (sql) =>
      voidExpense(sql, id),
    );
    return expense === undefined
      ? NextResponse.json({ error: "Not found" }, { status: 404 })
      : NextResponse.json({ expense });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
