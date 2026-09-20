import { NextResponse } from "next/server";
import {
  createTenantWithDefaults,
  listPlatformTenants,
  setFieldServiceEntitlement,
  initializeTenantConfiguration,
  configurationFromTemplate,
  tenantTemplateRegistry,
  type TenantTemplateKey,
} from "@or-on/crm";
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
    const templateKey =
      typeof body.templateKey === "string" &&
      Object.hasOwn(tenantTemplateRegistry, body.templateKey)
        ? (body.templateKey as TenantTemplateKey)
        : "blank";
    const mutationRequestId =
      request.headers.get("x-request-id") ?? crypto.randomUUID();
    const id = await withCurrentTenant(
      "platform:read",
      async (sql, session) => {
        if (!session.isSuperuser) throw new ForbiddenError("Forbidden");
        const tenantId = await createTenantWithDefaults(sql, {
          name: typeof body.name === "string" ? body.name : "",
          slug: typeof body.slug === "string" ? body.slug : "",
          currency: typeof body.currency === "string" ? body.currency : "USD",
          locale: body.locale === "he" ? "he" : "en",
          timezone: typeof body.timezone === "string" ? body.timezone : "UTC",
          ...(typeof body.ownerEmail === "string" && body.ownerEmail.trim()
            ? { ownerEmail: body.ownerEmail }
            : {}),
        });
        await setFieldServiceEntitlement(
          sql,
          tenantId,
          body.fieldServiceAvailable === true ||
            templateKey === "field_service",
          mutationRequestId,
        );
        await initializeTenantConfiguration(
          sql,
          tenantId,
          configurationFromTemplate(templateKey),
          mutationRequestId,
        );
        return tenantId;
      },
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
