import { NextResponse } from "next/server";
import {
  createCustomerClassification,
  listCustomerClassifications,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";
import { optionalText, text } from "../../../../features/field-service";

export async function GET() {
  try {
    const classifications = await withCurrentTenant("crm:read", (sql) =>
      listCustomerClassifications(sql),
    );
    return NextResponse.json({ classifications });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const description = optionalText(body.description, "Description");
    const color = optionalText(body.color, "Color");
    const classification = await withCurrentTenant(
      "tenant:manage",
      (sql, session) =>
        createCustomerClassification(sql, session.userId, {
          name: text(body.name, "Classification name"),
          ...(typeof description === "string" ? { description } : {}),
          ...(typeof color === "string" ? { color } : {}),
        }),
    );
    return NextResponse.json({ classification }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
