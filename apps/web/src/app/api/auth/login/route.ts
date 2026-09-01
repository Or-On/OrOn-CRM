import { NextResponse } from "next/server";

import {
  InvalidCredentialsError,
  assertTrustedUnsafeRequest,
  clientAddress,
} from "@or-on/auth";

import { jsonObject, requestId } from "../../../../features/auth/request";
import {
  setSessionCookies,
  withAuthService,
} from "../../../../features/auth/server";

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
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof TypeError) {
      return NextResponse.json({ error: "Request rejected" }, { status: 403 });
    }
    console.error("authentication login failed", {
      requestId: requestId(request),
    });
    return NextResponse.json(
      { error: "Authentication is temporarily unavailable" },
      { status: 503 },
    );
  }
}
