import { NextResponse } from "next/server";
import {
  linkCaseCall,
  linkCaseConversation,
  listServiceCaseLinkCandidates,
} from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";
import { uuid } from "../../../../../../features/field-service";

interface Context {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const candidates = await withCurrentTenant("field-service:manage", (sql) =>
      listServiceCaseLinkCandidates(sql, uuid(id, "Case")),
    );
    return NextResponse.json({ candidates });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    await assertCrmMutation(request);
    const [{ id }, body] = await Promise.all([
      context.params,
      jsonObject(request),
    ]);
    const caseId = uuid(id, "Case");
    const sourceId = uuid(body.sourceId, "Source");
    if (body.sourceKind !== "conversation" && body.sourceKind !== "call")
      throw new TypeError("Source kind must be conversation or call");
    await withCurrentTenant("field-service:manage", async (sql, session) => {
      if (body.sourceKind === "conversation")
        await linkCaseConversation(
          sql,
          caseId,
          sourceId,
          "resolved_ambiguity",
          session.userId,
          requestId(request),
        );
      else
        await linkCaseCall(
          sql,
          session.userId,
          caseId,
          sourceId,
          "resolved_ambiguity",
          requestId(request),
        );
    });
    return NextResponse.json({ linked: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
