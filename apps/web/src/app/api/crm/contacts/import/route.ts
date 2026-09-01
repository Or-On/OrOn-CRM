import { NextResponse } from "next/server";

import { importContacts, parseContactCsv } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (typeof body.csv !== "string")
      throw new TypeError("CSV text is required");
    if (body.csv.length > 1_000_000)
      throw new TypeError("CSV exceeds the 1 MB limit");
    const rows = parseContactCsv(body.csv);
    const result = await withCurrentTenant("crm:write", (sql, session) =>
      importContacts(sql, session.userId, rows),
    );
    return NextResponse.json(result);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
