import { NextResponse } from "next/server";
import { resolveServiceInquiry } from "@or-on/crm";
import { withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const body: unknown = await request.json();
    if (body === null || typeof body !== "object" || Array.isArray(body))
      throw new TypeError(
        "Select a resolution method, confirmation and summary",
      );
    const input = body as Record<string, unknown>;
    if (
      (input.method !== "telephone" && input.method !== "technician") ||
      (input.confirmation !== "customer" &&
        input.confirmation !== "authoritative_evidence") ||
      typeof input.summary !== "string"
    )
      throw new TypeError(
        "Select a resolution method, confirmation and summary",
      );
    const method = input.method;
    const confirmation = input.confirmation;
    const summary = input.summary;
    await withCurrentTenant("field-service:manage", (sql, session) =>
      resolveServiceInquiry(sql, session.userId, {
        ticketId: id,
        method,
        confirmation,
        summary,
      }),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
