import { NextResponse } from "next/server";

import {
  InvalidCredentialsError,
  applicationHome,
  applicationScope,
  assertTrustedUnsafeRequest,
  clientAddress,
} from "@or-on/auth";

import { jsonObject, requestId } from "../../../../features/auth";
import { setSessionCookies, withAuthService } from "../../../../features/auth";

export async function POST(request: Request) {
  try {
    assertTrustedUnsafeRequest(request);
    const body = await jsonObject(request);
    if (typeof body.email !== "string" || typeof body.password !== "string") {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 400 },
      );
    }
    const email = body.email;
    const password = body.password;
    const userAgent = request.headers.get("user-agent") ?? undefined;
    const ipAddress = clientAddress(request);
    const issued = await withAuthService((service) =>
      service.login({
        email,
        password,
        requestId: requestId(request),
        ...(userAgent === undefined ? {} : { userAgent }),
        ...(ipAddress === undefined ? {} : { ipAddress }),
      }),
    );
    await setSessionCookies(issued.sessionToken, issued.csrfToken);
    // Each login is its own session; sibling sessions of the account stay
    // valid. The landing page follows the session's application.
    const scope = applicationScope({
      role: issued.session.tenant.role,
      isSuperuser: issued.session.isSuperuser,
    });
    return NextResponse.json({ ok: true, home: applicationHome[scope] });
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof TypeError) {
      return NextResponse.json({ error: "Request rejected" }, { status: 403 });
    }
    console.error("authentication login failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
      requestId: requestId(request),
    });
    return NextResponse.json(
      { error: "Authentication is temporarily unavailable" },
      { status: 503 },
    );
  }
}
