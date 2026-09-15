import { NextResponse } from "next/server";

import { createContact, listContactPage } from "@or-on/crm";

import { jsonObject } from "../../../../features/auth";
import { withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  try {
    const parameters = new URL(request.url).searchParams;
    const query = parameters.get("q") ?? undefined;
    const cursorAt = parameters.get("cursorAt") ?? undefined;
    const cursorId = parameters.get("cursorId") ?? undefined;
    if ((cursorAt === undefined) !== (cursorId === undefined))
      throw new TypeError("Both contact cursor fields are required");
    if (cursorId !== undefined && !UUID.test(cursorId))
      throw new TypeError("Contact cursor is invalid");
    if (cursorAt !== undefined && !Number.isFinite(Date.parse(cursorAt)))
      throw new TypeError("Contact cursor is invalid");
    const requestedLimit = Number(parameters.get("limit") ?? "50");
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1)
      throw new TypeError("Contact page limit is invalid");
    const page = await withCurrentTenant("crm:read", (sql) =>
      listContactPage(sql, {
        ...(query === undefined ? {} : { query }),
        limit: requestedLimit,
        ...(cursorAt === undefined || cursorId === undefined
          ? {}
          : { cursor: { sortAt: cursorAt, id: cursorId } }),
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
    if (typeof body.name !== "string")
      throw new TypeError("contact name is required");
    const optionalString = (key: "phone" | "email" | "company") =>
      typeof body[key] === "string" ? body[key] : undefined;
    const phone = optionalString("phone");
    const email = optionalString("email");
    const company = optionalString("company");
    const tagIds = Array.isArray(body.tagIds)
      ? body.tagIds.filter(
          (value): value is string => typeof value === "string",
        )
      : undefined;
    const contact = await withCurrentTenant("crm:write", (sql, session) =>
      createContact(sql, session.userId, {
        name: body.name as string,
        ...(phone === undefined ? {} : { phone }),
        ...(email === undefined ? {} : { email }),
        ...(company === undefined ? {} : { company }),
        ...(tagIds === undefined ? {} : { tagIds }),
      }),
    );
    return NextResponse.json({ contact }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
