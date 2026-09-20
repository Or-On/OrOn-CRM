import { NextResponse } from "next/server";
import {
  getTenantConfigurationState,
  saveTenantConfigurationDraft,
  transitionTenantConfiguration,
} from "@or-on/crm";
import {
  ForbiddenError,
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

export async function GET() {
  try {
    return NextResponse.json({
      configuration: await withCurrentTenant("tenant:manage", (sql, session) =>
        getTenantConfigurationState(sql, session.isSuperuser),
      ),
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (
      body.expectedRevision !== null &&
      !Number.isInteger(body.expectedRevision)
    )
      throw new TypeError("Draft revision is required; refresh before saving");
    const configuration = await withCurrentTenant(
      "tenant:manage",
      async (sql, session) => {
        await saveTenantConfigurationDraft(
          sql,
          body.configuration,
          body.expectedRevision as number | null,
          requestId(request),
        );
        return getTenantConfigurationState(sql, session.isSuperuser);
      },
    );
    return NextResponse.json({ configuration });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (
      body.action !== "submit" &&
      body.action !== "approve" &&
      body.action !== "reject"
    )
      throw new TypeError("Choose a supported review action");
    if (!Number.isInteger(body.expectedRevision))
      throw new TypeError("Draft revision is required");
    if (body.note !== undefined && typeof body.note !== "string")
      throw new TypeError("Review note must be text");
    const action = body.action;
    const configuration = await withCurrentTenant(
      "tenant:manage",
      async (sql, session) => {
        if (action !== "submit" && !session.isSuperuser)
          throw new ForbiddenError(
            "Only a platform administrator can approve configurations",
          );
        await transitionTenantConfiguration(
          sql,
          action,
          body.expectedRevision as number,
          (body.note as string | undefined) ?? "",
          requestId(request),
        );
        return getTenantConfigurationState(sql, session.isSuperuser);
      },
    );
    return NextResponse.json({ configuration });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
