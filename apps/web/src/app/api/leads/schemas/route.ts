import { NextResponse } from "next/server";

import { createLeadFieldSchema, listLeadFieldSchemas } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

export async function GET() {
  try {
    return NextResponse.json({
      schemas: await withCurrentTenant("crm:read", listLeadFieldSchemas),
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

/**
 * Publish a reviewed field list. It is immutable once stored: editing it later
 * creates the next version, so an agent pinned to this one keeps asking these
 * questions until an operator deliberately repins and republishes it.
 */
export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (typeof body.name !== "string")
      throw new TypeError("a schema name is required");
    const schema = await withCurrentTenant("flows:manage", (sql, session) =>
      createLeadFieldSchema(sql, session.userId, {
        name: body.name as string,
        definition: body.fields,
        ...(typeof body.description === "string"
          ? { description: body.description }
          : {}),
      }),
    );
    return NextResponse.json(schema, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
