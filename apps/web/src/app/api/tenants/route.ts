import { NextResponse } from "next/server";
import { createTenantWithDefaults, listPlatformTenants } from "@or-on/crm";
import {
  ForbiddenError,
  jsonObject,
  withCurrentTenant,
} from "../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../features/crm-route";

export async function GET() {
  try {
    return NextResponse.json({
      tenants: await withCurrentTenant("platform:read", (sql, session) => {
        if (!session.isSuperuser) throw new ForbiddenError("Forbidden");
        return listPlatformTenants(sql);
      }),
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const id = await withCurrentTenant("platform:read", (sql, session) => {
      if (!session.isSuperuser) throw new ForbiddenError("Forbidden");
      return createTenantWithDefaults(sql, {
        name: typeof body.name === "string" ? body.name : "",
        slug: typeof body.slug === "string" ? body.slug : "",
        currency: typeof body.currency === "string" ? body.currency : "USD",
        locale: body.locale === "he" ? "he" : "en",
        timezone: typeof body.timezone === "string" ? body.timezone : "UTC",
        ...(typeof body.ownerEmail === "string" && body.ownerEmail.trim()
          ? { ownerEmail: body.ownerEmail }
          : {}),
      });
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
