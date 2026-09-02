import { NextResponse } from "next/server";

import {
  archiveContact,
  getContactDetail,
  setVoiceConsent,
  updateContact,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/crm/contacts/[id]">,
) {
  try {
    const { id } = await context.params;
    const contact = await withCurrentTenant("crm:read", (sql) =>
      getContactDetail(sql, id),
    );
    return contact === undefined
      ? NextResponse.json({ error: "Not found" }, { status: 404 })
      : NextResponse.json({ contact });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/crm/contacts/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const body = await jsonObject(request);
    const optional = (key: "name" | "email" | "company") =>
      typeof body[key] === "string" ? body[key] : undefined;
    const name = optional("name");
    const email = optional("email");
    const company = optional("company");
    const voiceConsent = body.voiceConsent;
    if (
      voiceConsent !== undefined &&
      voiceConsent !== "unknown" &&
      voiceConsent !== "granted" &&
      voiceConsent !== "revoked"
    ) {
      throw new TypeError("invalid voice consent");
    }
    const contact = await withCurrentTenant("crm:write", async (sql) => {
      const updated = await updateContact(sql, id, {
        ...(name === undefined ? {} : { name }),
        ...(email === undefined ? {} : { email }),
        ...(company === undefined ? {} : { company }),
      });
      if (updated === undefined || voiceConsent === undefined) return updated;
      return setVoiceConsent(sql, id, voiceConsent);
    });
    return contact === undefined
      ? NextResponse.json({ error: "Not found" }, { status: 404 })
      : NextResponse.json({ contact });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/crm/contacts/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const archived = await withCurrentTenant("crm:write", (sql) =>
      archiveContact(sql, id),
    );
    return archived
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
