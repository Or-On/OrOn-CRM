import {
  InvalidCredentialsError,
  assertTrustedUnsafeRequest,
  clientAddress,
} from "@or-on/auth";
import { NextResponse } from "next/server";

import {
  clearSessionCookies,
  jsonObject,
  requestId,
  setSessionCookies,
  withAuthService,
} from "../../../../../features/auth";

export async function POST(request: Request) {
  let committedAcceptance: { readonly accountCreated: boolean } | undefined;
  try {
    assertTrustedUnsafeRequest(request);
    const body = await jsonObject(request);
    if (
      typeof body.token !== "string" ||
      (body.password !== undefined && typeof body.password !== "string") ||
      (body.displayName !== undefined && typeof body.displayName !== "string")
    ) {
      throw new TypeError("invalid invitation acceptance");
    }
    const operationId = requestId(request);
    const userAgent = request.headers.get("user-agent") ?? undefined;
    const ipAddress = clientAddress(request);
    const result = await withAuthService(async (service) => {
      const invitation = await service.inspectInvitation(body.token as string);
      if (invitation === undefined) throw new InvalidCredentialsError();
      const acceptance = await service.acceptInvitation({
        token: body.token as string,
        ...(typeof body.password === "string"
          ? { password: body.password }
          : {}),
        ...(typeof body.displayName === "string"
          ? { displayName: body.displayName }
          : {}),
        requestId: operationId,
      });
      committedAcceptance = acceptance;
      const issued =
        acceptance.accountCreated && typeof body.password === "string"
          ? await service
              .login({
                email: invitation.email,
                password: body.password,
                requestId: operationId,
                ...(userAgent === undefined ? {} : { userAgent }),
                ...(ipAddress === undefined ? {} : { ipAddress }),
              })
              .catch(() => undefined)
          : undefined;
      return { acceptance, issued };
    });
    if (result.issued === undefined) await clearSessionCookies();
    else {
      try {
        await setSessionCookies(
          result.issued.sessionToken,
          result.issued.csrfToken,
        );
      } catch {
        // Acceptance has committed. Do not misreport an expired invitation or
        // leave the previously signed-in account active after a failed transition.
        await clearSessionCookies();
        return NextResponse.json({ ...result.acceptance, signedIn: false });
      }
    }
    return NextResponse.json({
      ...result.acceptance,
      signedIn: result.issued !== undefined,
    });
  } catch (error) {
    if (committedAcceptance) {
      // Repository teardown can fail after the acceptance transaction committed.
      // The account still exists; recovery is a normal sign-in, not token reuse.
      await clearSessionCookies();
      return NextResponse.json({ ...committedAcceptance, signedIn: false });
    }
    if (error instanceof InvalidCredentialsError)
      return NextResponse.json(
        { error: "Invitation is invalid or expired" },
        { status: 400 },
      );
    if (error instanceof TypeError)
      return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("Invitation acceptance failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "Invitation acceptance is temporarily unavailable" },
      { status: 503 },
    );
  }
}
