import { NextResponse } from "next/server";
import {
  getCustomerNationalIdEnvelope,
  updateCustomerDossier,
} from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";
import {
  protectNationalId,
  revealNationalId,
} from "../../../../../../features/protected-fields";
import { text, uuid } from "../../../../../../features/field-service";

export async function GET(
  request: Request,
  context: RouteContext<"/api/crm/contacts/[id]/national-id">,
) {
  try {
    const { id } = await context.params;
    const nationalId = await withCurrentTenant(
      "customer-sensitive:read",
      async (sql, session) => {
        const envelope = await getCustomerNationalIdEnvelope(
          sql,
          uuid(id, "Contact"),
        );
        await sql`
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id, request_id,
            metadata
          ) VALUES (
            platform.current_tenant_id(), ${session.userId}::uuid,
            'customer.sensitive_value.revealed', 'contact', ${id}::uuid,
            ${requestId(request)},
            ${sql.json({ field: "national_id", present: envelope !== undefined })}
          )
        `;
        return envelope === undefined
          ? null
          : revealNationalId(session.tenant.tenantId, envelope.ciphertext);
      },
    );
    return NextResponse.json(
      { nationalId },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/crm/contacts/[id]/national-id">,
) {
  try {
    await assertCrmMutation(request);
    const [{ id }, body] = await Promise.all([
      context.params,
      jsonObject(request),
    ]);
    const dossier = await withCurrentTenant(
      "customer-sensitive:write",
      async (sql, session) => {
        const updated = await updateCustomerDossier(sql, uuid(id, "Contact"), {
          nationalId:
            body.nationalId === null
              ? null
              : protectNationalId(
                  session.tenant.tenantId,
                  text(body.nationalId, "National ID"),
                ),
        });
        await sql`
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id, request_id,
            metadata
          ) VALUES (
            platform.current_tenant_id(), ${session.userId}::uuid,
            'customer.sensitive_value.updated', 'contact', ${id}::uuid,
            ${requestId(request)},
            ${sql.json({
              field: "national_id",
              cleared: body.nationalId === null,
            })}
          )
        `;
        return updated;
      },
    );
    return NextResponse.json({ dossier });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
