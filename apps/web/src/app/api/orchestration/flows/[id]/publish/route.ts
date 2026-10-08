import { NextResponse } from "next/server";

import {
  publishExecutableFlow,
  publishCanonicalWithBindings,
  PublicationConflictError,
} from "@or-on/crm";

import { withFreshCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

export async function POST(
  request: Request,
  context: RouteContext<"/api/orchestration/flows/[id]/publish">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const text = await request.text();
    if (text.trim()) {
      const body = JSON.parse(text) as Record<string, unknown>;
      if (
        typeof body.requestId !== "string" ||
        typeof body.expectedVersionId !== "string" ||
        typeof body.activate !== "boolean"
      )
        throw new TypeError(
          "requestId, expectedVersionId and activate are required",
        );
      const publication = await withFreshCurrentTenant(
        "flows:manage",
        (sql, session) =>
          publishCanonicalWithBindings(sql, session.userId, id, {
            requestId: body.requestId as string,
            expectedVersionId: body.expectedVersionId as string,
            activate: body.activate as boolean,
          }),
      );
      return NextResponse.json({ published: true, publication });
    }
    const published = await withFreshCurrentTenant(
      "flows:manage",
      (sql, session) => publishExecutableFlow(sql, session.userId, id),
    );
    if (!published)
      throw new TypeError(
        "publish a valid linked agent that supports every flow channel before publishing this flow",
      );
    return NextResponse.json({ published: true });
  } catch (error) {
    if (error instanceof PublicationConflictError)
      return NextResponse.json({ error: error.message }, { status: 409 });
    return crmErrorResponse(error);
  }
}
