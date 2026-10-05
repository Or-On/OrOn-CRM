import { NextResponse } from "next/server";

import {
  AgentProfileVersionConflictError,
  publishAgentProfile,
} from "@or-on/crm";

import { withFreshCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

async function expectedVersion(request: Request): Promise<string | undefined> {
  const text = await request.text();
  if (text.trim() === "") return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new TypeError("A JSON object is required");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body))
    throw new TypeError("A JSON object is required");
  const value = (body as Record<string, unknown>).expectedVersionId;
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(value)
  )
    throw new TypeError("expectedVersionId must be a UUID");
  return value.toLowerCase();
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/orchestration/agents/[id]/publish">,
) {
  try {
    await assertCrmMutation(request);
    const expectedVersionId = await expectedVersion(request);
    const { id } = await context.params;
    const published = await withFreshCurrentTenant(
      "flows:manage",
      (sql, session) =>
        publishAgentProfile(sql, session.userId, id, expectedVersionId),
    );
    if (!published) throw new TypeError("no valid unpublished version exists");
    return NextResponse.json({ published: true });
  } catch (error) {
    if (error instanceof AgentProfileVersionConflictError)
      return NextResponse.json(
        { error: error.message, code: "AGENT_VERSION_CHANGED" },
        { status: 409 },
      );
    return crmErrorResponse(error);
  }
}
