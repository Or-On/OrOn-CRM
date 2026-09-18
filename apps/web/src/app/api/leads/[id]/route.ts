import { NextResponse } from "next/server";

import {
  getLeadDetail,
  operatorLeadStatuses,
  updateLeadForOperator,
  LeadWorkspaceConflictError,
  requireTenantFeature,
  type LeadOperatorUpdate,
  type OperatorLeadStatus,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";
import { optionalText, uuid } from "../../../../features/field-service";

const statuses = new Set<string>(operatorLeadStatuses);

function operatorStatus(value: unknown): OperatorLeadStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !statuses.has(value))
    throw new TypeError("Lead status is not one of the operator statuses");
  return value as OperatorLeadStatus;
}

/** `null` clears the owner; absent leaves it alone. Those differ. */
function ownerUserId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return uuid(value, "Lead owner");
}

function dueAt(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new TypeError("Next action due date must be a timestamp or null");
  return value;
}

export async function GET(
  _request: Request,
  context: RouteContext<"/api/leads/[id]">,
) {
  try {
    const { id } = await context.params;
    const detail = await withCurrentTenant("crm:read", async (sql) => {
      await requireTenantFeature(sql, "leads");
      return getLeadDetail(sql, uuid(id, "Lead"));
    });
    if (detail === undefined)
      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    return NextResponse.json({ detail });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/leads/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const [{ id }, body] = await Promise.all([
      context.params,
      jsonObject(request),
    ]);
    const status = operatorStatus(body.status);
    const owner = ownerUserId(body.ownerUserId);
    const nextAction = optionalText(body.nextAction, "Next action");
    const nextActionDueAt = dueAt(body.nextActionDueAt);
    const summary = optionalText(body.summary, "Summary");
    if (
      body.expectedRevision !== undefined &&
      !Number.isSafeInteger(body.expectedRevision)
    )
      throw new TypeError("Expected revision must be a whole number");
    const update: LeadOperatorUpdate = {
      ...(status === undefined ? {} : { status }),
      ...(owner === undefined ? {} : { ownerUserId: owner }),
      ...(nextAction === undefined ? {} : { nextAction }),
      ...(nextActionDueAt === undefined ? {} : { nextActionDueAt }),
      ...(summary === undefined ? {} : { summary }),
      ...(typeof body.expectedRevision === "number"
        ? { expectedRevision: body.expectedRevision }
        : {}),
    };
    const lead = await withCurrentTenant("crm:write", async (sql, session) => {
      await requireTenantFeature(sql, "leads");
      return updateLeadForOperator(
        sql,
        session.userId,
        uuid(id, "Lead"),
        update,
      );
    });
    return NextResponse.json({ lead });
  } catch (error) {
    // A losing concurrent edit is reported with the revision the operator has
    // to reconcile against, not as a generic failure they can only retry blind.
    if (error instanceof LeadWorkspaceConflictError)
      return NextResponse.json(
        {
          error: "This lead changed while you were editing it",
          currentRevision: error.currentRevision,
        },
        { status: 409 },
      );
    return crmErrorResponse(error);
  }
}
