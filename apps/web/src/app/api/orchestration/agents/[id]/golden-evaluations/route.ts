import { NextResponse } from "next/server";
import {
  getAgentGoldenWorkspace,
  requestAgentGoldenEvaluation,
} from "@or-on/crm";
import {
  jsonObject,
  withCurrentTenant,
  withFreshCurrentTenant,
} from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

interface Context {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const versionId = new URL(request.url).searchParams.get("versionId");
    const workspace = await withCurrentTenant("flows:manage", (sql) =>
      getAgentGoldenWorkspace(sql, id, versionId),
    );
    return NextResponse.json(workspace, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const body = await jsonObject(request);
    const jobId = await withFreshCurrentTenant("flows:manage", (sql) =>
      requestAgentGoldenEvaluation(sql, id, body),
    );
    return NextResponse.json(
      { id: jobId },
      { status: 201, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
