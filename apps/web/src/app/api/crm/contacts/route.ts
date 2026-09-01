import { NextResponse } from "next/server";

import { createContact, listContacts } from "@or-on/crm";

import { jsonObject } from "../../../../features/auth";
import { withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams.get("q") ?? undefined;
    const contacts = await withCurrentTenant("crm:read", (sql) =>
      listContacts(sql, query === undefined ? {} : { query }),
    );
    return NextResponse.json({ contacts });
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
