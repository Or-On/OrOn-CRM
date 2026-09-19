import { NextResponse } from "next/server";

import {
  leadFieldStates,
  operatorLeadBinding,
  saveLeadFields,
  LeadFieldValidationError,
  LeadNotFoundError,
  LeadRevisionConflictError,
  type LeadFieldObservationInput,
  type LeadFieldState,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

const states = new Set<string>(leadFieldStates);

function observation(value: unknown, index: number): LeadFieldObservationInput {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`Field ${String(index + 1)} must be an object`);
  const entry = value as Record<string, unknown>;
  if (typeof entry.key !== "string" || entry.key.trim() === "")
    throw new TypeError(`Field ${String(index + 1)} is missing its key`);
  if (typeof entry.state !== "string" || !states.has(entry.state))
    throw new TypeError(`Field ${entry.key} has an unsupported state`);
  if (entry.value !== undefined && typeof entry.value !== "string")
    throw new TypeError(`Field ${entry.key} must carry text or no value`);
  if (entry.currency !== undefined && typeof entry.currency !== "string")
    throw new TypeError(`Field ${entry.key} has an invalid currency`);
  return {
    key: entry.key,
    state: entry.state as LeadFieldState,
    ...(entry.value === undefined ? {} : { value: entry.value }),
    ...(entry.currency === undefined ? {} : { currency: entry.currency }),
    // A person typing into the workspace is the strongest confirmation the
    // platform records, and it is set here rather than accepted from the body
    // so a caller cannot file an unchecked guess as verified.
    confirmation: "human_verified",
  };
}

/**
 * Correct collected lead fields by hand.
 *
 * Runs through the same validation and provenance path an agent write uses, so
 * a typed correction is normalised, versioned and superseded exactly like a
 * captured one — and outranks any later machine extraction of the same field.
 */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/leads/[id]/fields">,
) {
  try {
    await assertCrmMutation(request);
    const [{ id }, body] = await Promise.all([
      context.params,
      jsonObject(request),
    ]);
    if (!Array.isArray(body.fields) || body.fields.length === 0)
      throw new TypeError("At least one field correction is required");
    const observations = body.fields.map((entry, index) =>
      observation(entry, index),
    );
    if (
      body.expectedRevision !== undefined &&
      !Number.isSafeInteger(body.expectedRevision)
    )
      throw new TypeError("Expected revision must be a whole number");
    // The browser supplies the operation key so a resubmitted form reconciles
    // with the write it already made instead of issuing a second one.
    const operationKey =
      typeof body.operationKey === "string" && body.operationKey.trim() !== ""
        ? body.operationKey
        : `lead-operator-${crypto.randomUUID()}`;
    const result = await withCurrentTenant(
      "crm:write",
      async (sql, session) => {
        const binding = await operatorLeadBinding(sql, session.userId, id);
        return saveLeadFields(sql, binding, {
          leadId: id,
          operationKey,
          observations,
          ...(typeof body.expectedRevision === "number"
            ? { expectedRevision: body.expectedRevision }
            : {}),
        });
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LeadRevisionConflictError)
      return NextResponse.json(
        {
          error: "This lead changed while you were editing it",
          currentRevision: error.currentRevision,
        },
        { status: 409 },
      );
    if (error instanceof LeadFieldValidationError)
      return NextResponse.json(
        { error: error.message, field: error.field },
        { status: 400 },
      );
    if (error instanceof LeadNotFoundError)
      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    return crmErrorResponse(error);
  }
}
