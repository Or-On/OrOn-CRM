import { NextResponse } from "next/server";

import { getCurrentTenantLogo, setCurrentTenantLogo } from "@or-on/crm";

import {
  requestId,
  withCurrentShellTenant,
  withCurrentTenant,
} from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";
import { readIdentityImage } from "../../../../features/identity";

class TenantLogoContextError extends Error {}

function assertLogoContext(
  request: Request,
  tenantId: string,
  required = false,
) {
  const expected = new URL(request.url).searchParams.get("context");
  if ((required || expected !== null) && expected !== tenantId)
    throw new TenantLogoContextError();
}

function logoErrorResponse(error: unknown) {
  const response =
    error instanceof TenantLogoContextError
      ? NextResponse.json(
          { error: "Workspace changed. Refresh before changing its logo." },
          { status: 409 },
        )
      : crmErrorResponse(error);
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export async function GET(request: Request) {
  try {
    // The workspace logo brands every application shell, including the
    // technician Field Service app; changing it stays a tenant setting.
    const image = await withCurrentShellTenant((sql, session) => {
      assertLogoContext(request, session.tenant.tenantId);
      return getCurrentTenantLogo(sql);
    });
    if (image === undefined)
      return new Response(null, {
        status: 404,
        headers: { "cache-control": "private, no-store" },
      });
    return new Response(new Uint8Array(image.data), {
      headers: {
        "cache-control": "private, no-store",
        "content-type": image.contentType,
        "last-modified": new Date(image.updatedAt).toUTCString(),
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return logoErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await assertCrmMutation(request);
    const image = await readIdentityImage(request);
    await withCurrentTenant("tenant:manage", (sql, session) => {
      assertLogoContext(request, session.tenant.tenantId, true);
      return setCurrentTenantLogo(sql, image, requestId(request));
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return logoErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await assertCrmMutation(request);
    await withCurrentTenant("tenant:manage", (sql, session) => {
      assertLogoContext(request, session.tenant.tenantId, true);
      return setCurrentTenantLogo(sql, undefined, requestId(request));
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return logoErrorResponse(error);
  }
}
