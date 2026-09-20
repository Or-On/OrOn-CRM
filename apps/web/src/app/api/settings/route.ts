import { NextResponse } from "next/server";

import {
  updateCurrentTenantName,
  updateTenantSettings,
  type IdentityVerificationPolicy,
  type TenantSupportProfile,
  tenantSupportTextLimits,
} from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../features/crm-route";

export async function PATCH(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request, {
      maximumBytes: tenantSupportTextLimits.profileBytes + 16_384,
    });
    if (
      typeof body.defaultCurrency !== "string" ||
      typeof body.locale !== "string" ||
      typeof body.timezone !== "string" ||
      typeof body.tenantName !== "string" ||
      (body.displayName !== null && typeof body.displayName !== "string") ||
      ![
        "businessName",
        "businessEmail",
        "businessPhone",
        "businessAddress",
        "reportHeader",
        "reportFooter",
      ].every(
        (key) =>
          body[key] === undefined ||
          body[key] === null ||
          typeof body[key] === "string",
      ) ||
      (body.accentToken !== undefined &&
        body.accentToken !== null &&
        typeof body.accentToken !== "string") ||
      (body.supportProfile !== undefined &&
        (body.supportProfile === null ||
          typeof body.supportProfile !== "object" ||
          Array.isArray(body.supportProfile))) ||
      (body.identityVerification !== undefined &&
        (body.identityVerification === null ||
          typeof body.identityVerification !== "object" ||
          Array.isArray(body.identityVerification)))
    ) {
      throw new TypeError("invalid workspace settings");
    }
    const result = await withCurrentTenant("tenant:manage", async (sql) => {
      const settings = await updateTenantSettings(sql, {
        displayName: body.displayName as string | null,
        defaultCurrency: body.defaultCurrency as string,
        locale: body.locale as string,
        timezone: body.timezone as string,
        ...(body.businessName === undefined
          ? {}
          : { businessName: body.businessName as string | null }),
        ...(body.businessEmail === undefined
          ? {}
          : { businessEmail: body.businessEmail as string | null }),
        ...(body.businessPhone === undefined
          ? {}
          : { businessPhone: body.businessPhone as string | null }),
        ...(body.businessAddress === undefined
          ? {}
          : { businessAddress: body.businessAddress as string | null }),
        ...(body.accentToken === undefined
          ? {}
          : {
              accentToken: body.accentToken as
                | "blue"
                | "cyan"
                | "emerald"
                | "violet"
                | "amber"
                | "rose"
                | null,
            }),
        ...(body.reportHeader === undefined
          ? {}
          : { reportHeader: body.reportHeader as string | null }),
        ...(body.reportFooter === undefined
          ? {}
          : { reportFooter: body.reportFooter as string | null }),
        ...(body.supportProfile === undefined
          ? {}
          : {
              supportProfile:
                body.supportProfile as unknown as TenantSupportProfile,
            }),
        ...(body.identityVerification === undefined
          ? {}
          : {
              identityVerification:
                body.identityVerification as unknown as IdentityVerificationPolicy,
            }),
      });
      const tenantName = await updateCurrentTenantName(
        sql,
        body.tenantName as string,
        requestId(request),
      );
      return { settings, tenantName };
    });
    return NextResponse.json(result);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
