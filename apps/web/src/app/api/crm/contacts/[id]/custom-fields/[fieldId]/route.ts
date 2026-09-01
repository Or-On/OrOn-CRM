import { NextResponse } from "next/server";

import { setContactCustomField, type JsonValue } from "@or-on/crm";

import {
  jsonObject,
  withCurrentTenant,
} from "../../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../../features/crm-route";

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value))
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value).every(isJsonValue);
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/crm/contacts/[id]/custom-fields/[fieldId]">,
) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (!isJsonValue(body.value))
      throw new TypeError("field value must be JSON-safe");
    const { id, fieldId } = await context.params;
    await withCurrentTenant("crm:write", (sql) =>
      setContactCustomField(sql, id, fieldId, body.value as JsonValue),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
