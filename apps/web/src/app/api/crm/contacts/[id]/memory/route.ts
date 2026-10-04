import { NextResponse } from "next/server";
import { correctCustomerMemoryFact } from "@or-on/crm";
import { jsonObject, withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const body = await jsonObject(request);
    if (
      Object.keys(body).some(
        (key) => !["factId", "value", "reason"].includes(key),
      ) ||
      typeof body.factId !== "string" ||
      typeof body.reason !== "string" ||
      (body.value !== null && typeof body.value !== "string")
    )
      throw new TypeError("invalid memory correction");
    const correctionId = await withCurrentTenant("crm:write", (sql) =>
      correctCustomerMemoryFact(sql, {
        contactId: id,
        factId: body.factId as string,
        value: body.value as string | null,
        reason: body.reason as string,
      }),
    );
    return correctionId === null
      ? NextResponse.json(
          { error: "Not found" },
          { status: 404, headers: { "cache-control": "private, no-store" } },
        )
      : NextResponse.json(
          { correctionId },
          { headers: { "cache-control": "private, no-store" } },
        );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
