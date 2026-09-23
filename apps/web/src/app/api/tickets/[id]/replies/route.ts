import { NextResponse } from "next/server";
import { linkCustomerReply, requireTenantFeature } from "@or-on/crm";

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
 * Link a customer reply that could belong to more than one open inquiry.
 * The platform never guesses; a person chooses among the candidates.
 */
export async function POST(request: Request, context: Context) {
  try {
    await assertCrmMutation(request);
    await context.params;
    const body = await jsonObject(request);
    const messageId = uuid(body.messageId, "Message");
    const intakeId = uuid(body.intakeId, "Inquiry");
    await withCurrentTenant("crm:write", async (sql) => {
      await requireTenantFeature(sql, "tickets");
      await linkCustomerReply(sql, messageId, intakeId);
    });
    return NextResponse.json({ linked: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
