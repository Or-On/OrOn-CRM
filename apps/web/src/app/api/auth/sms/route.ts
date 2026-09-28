import { NextResponse } from "next/server";
import {
  InvalidCredentialsError,
  applicationHome,
  applicationScope,
  assertTrustedUnsafeRequest,
  clientAddress,
} from "@or-on/auth";
import {
  jsonObject,
  requestId,
  setSessionCookies,
  withAuthService,
} from "../../../../features/auth";

export async function POST(request: Request) {
  try {
    assertTrustedUnsafeRequest(request);
    const body = await jsonObject(request, { maximumBytes: 1024 });
    if (
      typeof body.id !== "string" ||
      typeof body.code !== "string" ||
      !/^[0-9a-f-]{36}$/u.test(body.id) ||
      !/^\d{6}$/u.test(body.code)
    )
      return NextResponse.json(
        { error: "Invalid verification code" },
        { status: 400 },
      );
    const userAgent = request.headers.get("user-agent") ?? undefined;
    const ipAddress = clientAddress(request);
    const id = body.id,
      code = body.code;
    const issued = await withAuthService((service) =>
      service.finishSmsLogin({
        id,
        code,
        requestId: requestId(request),
        ...(userAgent === undefined ? {} : { userAgent }),
        ...(ipAddress === undefined ? {} : { ipAddress }),
      }),
    );
    await setSessionCookies(issued.sessionToken, issued.csrfToken);
    return NextResponse.json(
      {
        ok: true,
        home: applicationHome[
          applicationScope({
            role: issued.session.tenant.role,
            isSuperuser: issued.session.isSuperuser,
          })
        ],
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const status =
      error instanceof InvalidCredentialsError
        ? 401
        : error instanceof TypeError
          ? 403
          : 503;
    return NextResponse.json(
      {
        error:
          status === 503
            ? "SMS verification is unavailable"
            : "Verification rejected",
      },
      { status },
    );
  }
}
