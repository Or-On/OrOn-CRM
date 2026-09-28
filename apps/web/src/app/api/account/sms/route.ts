import { NextResponse } from "next/server";
import {
  assertAuthenticatedMutation,
  currentRawSession,
  jsonObject,
  requestId,
  UnauthenticatedError,
  withAuthService,
  withStaffSms,
} from "../../../../features/auth";

export async function GET() {
  const current = await currentRawSession();
  if (current === undefined)
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const status = await withStaffSms(async (sms) => ({
    available: sms.available,
    phoneHint: (await sms.phoneHint(current.session.userId)) ?? null,
  }));
  return NextResponse.json(status, {
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  try {
    const session = await assertAuthenticatedMutation(request);
    const body = await jsonObject(request, { maximumBytes: 2048 });
    if (body.purpose !== "staff_enrollment" && body.purpose !== "staff_disable")
      throw new TypeError("Invalid purpose");
    const purpose = body.purpose;
    if (body.action === "start") {
      if (
        typeof body.password !== "string" ||
        !(await withAuthService((service) =>
          service.verifyCurrentPassword(session, body.password as string),
        ))
      )
        return NextResponse.json(
          { error: "Verification rejected" },
          { status: 401 },
        );
      const phone =
        purpose === "staff_enrollment" && typeof body.phone === "string"
          ? body.phone
          : undefined;
      if (
        purpose === "staff_enrollment" &&
        (phone === undefined || !/^\+[1-9]\d{7,14}$/u.test(phone))
      )
        return NextResponse.json(
          { error: "Use an international phone number" },
          { status: 400 },
        );
      const challenge = await withStaffSms((sms) =>
        sms.start(purpose, session.userId, session.sessionId, phone),
      );
      return NextResponse.json(
        { challenge },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (
      body.action !== "complete" ||
      typeof body.id !== "string" ||
      typeof body.code !== "string"
    )
      throw new TypeError("Invalid verification code");
    const id = body.id,
      code = body.code;
    const result = await withStaffSms((sms) =>
      sms.complete(
        purpose,
        id,
        code,
        requestId(request),
        session.userId,
        session.sessionId,
      ),
    );
    return result === undefined
      ? NextResponse.json(
          { error: "Invalid or expired verification code" },
          { status: 401 },
        )
      : NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: "SMS verification is unavailable or the request was rejected" },
      {
        status:
          error instanceof UnauthenticatedError
            ? 401
            : error instanceof TypeError
              ? 403
              : 503,
      },
    );
  }
}
