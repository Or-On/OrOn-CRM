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
  const errorCode =
    error !== null && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  if (
    errorCode === "TENANT_FEATURE_DISABLED" ||
    (error instanceof Error && error.name === "TenantFeatureDisabledError")
  )
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "This module is not enabled for this workspace",
        code: "TENANT_FEATURE_DISABLED",
      },
      { status: 403 },
    );
  if (error instanceof TypeError)
    return NextResponse.json({ error: error.message }, { status: 400 });
  // A workflow requirement the user can satisfy (a missing before/after
  // photo, an unacknowledged preparation) is explained, not hidden.
  if (
    error instanceof Error &&
    error.name === "FieldWorkflowRequirementError" &&
    "messages" in error &&
    "code" in error
  ) {
    const messages = error.messages as {
      readonly en: string;
      readonly he: string;
    };
    return NextResponse.json(
      { error: messages.en, messages, code: error.code },
      { status: 422 },
    );
  }
  const code = errorCode;
  if (code === "23505")
    return NextResponse.json(
      { error: "A matching record already exists" },
      { status: 409 },
    );
  if (code === "FS_TECHNICIAN_IN_USE")
    return NextResponse.json(
      {
        error:
          "This technician has existing work. Deactivate the technician to preserve visit history.",
      },
      { status: 409 },
    );
  if (code === "23P01")
    return NextResponse.json(
      { error: "This technician already has a conflicting appointment" },
      { status: 409 },
    );
  // A shared technician account works only after this browser session names
  // its physical technician; the codes come from the session-binding SQL.
  if (code === "FS428")
    return NextResponse.json(
      {
        error:
          "Choose which technician is using this device before continuing.",
        code: "TECHNICIAN_IDENTIFICATION_REQUIRED",
      },
      { status: 428 },
    );
  if (code === "FS401")
    return NextResponse.json(
      {
        error: "The employee ID does not match this technician profile.",
        code: "TECHNICIAN_IDENTITY_MISMATCH",
      },
      { status: 403 },
    );
  if (code === "FS409")
    return NextResponse.json(
      {
        error:
          "This device is already identified as another technician. Switch technician first.",
        code: "TECHNICIAN_SESSION_ALREADY_BOUND",
      },
      { status: 409 },
    );
  if (code === "42501" || code === "TF403")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (code === "40001")
    return NextResponse.json(
      { error: "Configuration changed; refresh and try again" },
      { status: 409 },
    );
  if (code === "TF409")
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The module is still required by active configuration",
      },
      { status: 409 },
    );
  if (code === "55006")
    return NextResponse.json(
      {
        error:
          "The tenant has active calls or provider work. Try again after it finishes.",
      },
      { status: 409 },
    );
  if (code === "P0002")
    return NextResponse.json(
      { error: "The requested record was not found" },
      { status: 404 },
    );
  if (code === "22023" || code === "23514")
    return NextResponse.json(
      { error: "The request violates a platform constraint" },
      { status: 400 },
    );
  console.error("CRM request failed", {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  return NextResponse.json(
    { error: "The CRM operation is temporarily unavailable" },
    { status: 503 },
  );
}
