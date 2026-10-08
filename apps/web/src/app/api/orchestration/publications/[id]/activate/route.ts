import {
  activateRetainedPublication,
  PublicationConflictError,
} from "@or-on/crm";
import { withFreshCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const result = await withFreshCurrentTenant(
      "flows:manage",
      (sql, session) =>
        activateRetainedPublication(sql, session.userId, id, true),
    );
    return Response.json({ publication: result });
  } catch (error) {
    if (error instanceof PublicationConflictError)
      return Response.json({ error: error.message }, { status: 409 });
    return crmErrorResponse(error);
  }
}
