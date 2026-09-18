import { NextResponse } from "next/server";
import {
  createTenantProcess,
  listTenantProcesses,
  type TenantProcessInput,
} from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

function input(body: Record<string, unknown>): TenantProcessInput {
  if (
    typeof body.name !== "string" ||
    typeof body.trigger !== "string" ||
    typeof body.enabled !== "boolean"
  )
    throw new TypeError("name, trigger and enabled are required");
  return body as unknown as TenantProcessInput;
}

export async function GET() {
  try {
    return NextResponse.json({
      processes: await withCurrentTenant("platform:read", listTenantProcesses),
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const process = await withCurrentTenant("tenant:manage", (sql, session) =>
      createTenantProcess(sql, session.userId, input(body), requestId(request)),
    );
    return NextResponse.json({ process }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
