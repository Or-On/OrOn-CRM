import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { assertTrustedUnsafeRequest } from "@or-on/auth";

import {
  CSRF_COOKIE,
  currentRawSession,
  issueLiveAgentGrant,
  withAuthService,
} from "../../../../features/auth/server";

export async function POST(request: Request) {
  try {
    assertTrustedUnsafeRequest(request);
    const resolved = await currentRawSession();
    if (resolved === undefined)
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    const csrfCookie = (await cookies()).get(CSRF_COOKIE)?.value ?? "";
    const csrfHeader = request.headers.get("x-csrf-token") ?? "";
    await withAuthService(async (service) =>
      service.validateCsrf(resolved.session, csrfCookie, csrfHeader),
    );
    const token = await issueLiveAgentGrant(resolved.session);
    return NextResponse.json({ token, expiresIn: 60 });
  } catch {
    return NextResponse.json({ error: "Request rejected" }, { status: 403 });
  }
}
