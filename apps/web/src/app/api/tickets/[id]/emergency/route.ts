import { NextResponse } from "next/server";
import { markTicketEmergency, requireTenantFeature } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";
import { uuid } from "../../../../../features/field-service";

interface Context {
  readonly params: Promise<{ readonly id: string }>;
}

/**
 * Mark an inquiry as the tenant's emergency ("red call"). PostgreSQL decides:
 * the tenant must enable manual emergencies and the actor must be an owner,
 * administrator or dispatcher; the change is audited on the timeline.
 */
export async function POST(request: Request, context: Context) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const ticketId = uuid(id, "Inquiry");
    const body = await jsonObject(request);
    if (typeof body.reason !== "string")
      throw new TypeError("Describe why this call is an emergency");
    const reason = body.reason;
    const receipt = await withCurrentTenant("crm:write", async (sql) => {
      await requireTenantFeature(sql, "tickets");
      return markTicketEmergency(sql, ticketId, reason);
    });
    return NextResponse.json(receipt);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
