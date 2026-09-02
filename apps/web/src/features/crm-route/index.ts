import { NextResponse } from "next/server";

import {
  assertAuthenticatedMutation,
  ForbiddenError,
  UnauthenticatedError,
} from "../auth";

export async function assertCrmMutation(request: Request): Promise<void> {
  await assertAuthenticatedMutation(request);
}

export function crmErrorResponse(error: unknown): NextResponse {
  if (error instanceof UnauthenticatedError)
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (error instanceof ForbiddenError)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (error instanceof TypeError)
    return NextResponse.json({ error: error.message }, { status: 400 });
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  if (code === "23505")
    return NextResponse.json(
      { error: "A matching record already exists" },
      { status: 409 },
    );
  console.error("CRM request failed", {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  return NextResponse.json(
    { error: "The CRM operation is temporarily unavailable" },
    { status: 503 },
  );
}
