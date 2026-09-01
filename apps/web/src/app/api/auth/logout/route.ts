import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { assertTrustedUnsafeRequest } from "@or-on/auth";

import { requestId } from "../../../../features/auth";
import {
  CSRF_COOKIE,
  clearSessionCookies,
  currentRawSession,
  withAuthService,
} from "../../../../features/auth";

export async function POST(request: Request) {
  try {
    assertTrustedUnsafeRequest(request);
    const resolved = await currentRawSession();
    if (resolved !== undefined) {
      const csrfCookie = (await cookies()).get(CSRF_COOKIE)?.value ?? "";
      const csrfHeader = request.headers.get("x-csrf-token") ?? "";
      await withAuthService(async (service) => {
        service.validateCsrf(resolved.session, csrfCookie, csrfHeader);
        await service.logout(resolved.token, requestId(request));
      });
    }
    await clearSessionCookies();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Request rejected" }, { status: 403 });
  }
}
