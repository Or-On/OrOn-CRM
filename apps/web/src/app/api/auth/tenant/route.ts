import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { assertTrustedUnsafeRequest } from "@or-on/auth";

import { jsonObject, requestId } from "../../../../features/auth/request";
import {
  CSRF_COOKIE,
  currentRawSession,
  setSessionCookies,
  withAuthService,
} from "../../../../features/auth/server";

export async function POST(request: Request) {
  try {
    assertTrustedUnsafeRequest(request);
    const body = await jsonObject(request);
    if (typeof body.tenantId !== "string")
      throw new TypeError("tenantId is required");
    const tenantId = body.tenantId;
    const resolved = await currentRawSession();
    if (resolved === undefined)
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    const csrfCookie = (await cookies()).get(CSRF_COOKIE)?.value ?? "";
    const csrfHeader = request.headers.get("x-csrf-token") ?? "";
    const rotated = await withAuthService(async (service) => {
      service.validateCsrf(resolved.session, csrfCookie, csrfHeader);
      return service.switchTenant({
        requestId: requestId(request),
        sessionToken: resolved.token,
        tenantId,
      });
    });
    await setSessionCookies(rotated.sessionToken, rotated.csrfToken);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Request rejected" }, { status: 403 });
  }
}
