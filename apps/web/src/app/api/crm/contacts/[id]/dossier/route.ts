import { NextResponse } from "next/server";
import { getCustomerDossier, updateCustomerDossier } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";
import { optionalText, uuid } from "../../../../../../features/field-service";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/crm/contacts/[id]/dossier">,
) {
  try {
    const { id } = await context.params;
    const dossier = await withCurrentTenant("crm:read", (sql) =>
      getCustomerDossier(sql, uuid(id, "Contact")),
    );
    return dossier === undefined
      ? NextResponse.json({ error: "Contact not found" }, { status: 404 })
      : NextResponse.json({ dossier });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/crm/contacts/[id]/dossier">,
) {
  try {
    await assertCrmMutation(request);
    const [{ id }, body] = await Promise.all([
      context.params,
      jsonObject(request),
    ]);
    const preferredLanguage = optionalText(
      body.preferredLanguage,
      "Preferred language",
    );
    const address = optionalText(body.address, "Address");
    const dossier = await withCurrentTenant("crm:write", (sql) =>
      updateCustomerDossier(sql, uuid(id, "Contact"), {
        ...(preferredLanguage === undefined ? {} : { preferredLanguage }),
        ...(address === undefined ? {} : { address }),
      }),
    );
    return NextResponse.json({ dossier });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
