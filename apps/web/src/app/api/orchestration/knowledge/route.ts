import { NextResponse } from "next/server";
import {
  changeKnowledgePublication,
  createKnowledgeDraft,
  listKnowledgeVersions,
} from "@or-on/crm";
import {
  jsonObject,
  withCurrentTenant,
  withFreshCurrentTenant,
} from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

export async function GET() {
  try {
    return NextResponse.json({
      versions: await withCurrentTenant("flows:manage", listKnowledgeVersions),
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const id = await withFreshCurrentTenant("flows:manage", (sql, session) =>
      createKnowledgeDraft(sql, session.userId, body),
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (
      typeof body.documentId !== "string" ||
      (body.action !== "publish" && body.action !== "revoke")
    )
      throw new TypeError("document and publication action are required");
    const documentId = body.documentId;
    const action = body.action;
    await withFreshCurrentTenant("flows:manage", (sql, session) =>
      changeKnowledgePublication(sql, session.userId, documentId, action),
    );
    return NextResponse.json({ updated: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
