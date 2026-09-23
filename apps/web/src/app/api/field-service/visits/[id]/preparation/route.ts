import { NextResponse } from "next/server";
import {
  acknowledgeVisitPreparation,
  getVisitPreparation,
  requireFieldService,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";
import { uuid } from "../../../../../../features/field-service";

interface Context {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const visitId = uuid(id, "Visit");
    const preparation = await withCurrentTenant(
      "field-service:read",
      async (sql) => {
        await requireFieldService(sql);
        return getVisitPreparation(sql, visitId);
      },
    );
    return NextResponse.json({ preparation });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

/** The assigned technician's acknowledgement, bound to the exact requirements. */
export async function POST(request: Request, context: Context) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const visitId = uuid(id, "Visit");
    const body = await jsonObject(request);
    if (
      typeof body.requirementsHash !== "string" ||
      !Array.isArray(body.checkedItems) ||
      body.checkedItems.some((item) => typeof item !== "string")
    )
      throw new TypeError("Preparation acknowledgement is invalid");
    const requirementsHash = body.requirementsHash;
    const checkedItems = body.checkedItems as string[];
    const preparation = await withCurrentTenant(
      "field-service:operate",
      async (sql) => {
        await requireFieldService(sql);
        return acknowledgeVisitPreparation(sql, {
          visitId,
          requirementsHash,
          checkedItems,
        });
      },
    );
    return NextResponse.json({ preparation });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
