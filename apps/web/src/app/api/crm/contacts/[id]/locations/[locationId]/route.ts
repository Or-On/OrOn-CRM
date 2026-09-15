import { NextResponse } from "next/server";
import { archiveServiceLocation, updateServiceLocation } from "@or-on/crm";

import {
  jsonObject,
  withCurrentTenant,
} from "../../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../../features/crm-route";
import {
  optionalText,
  text,
  uuid,
} from "../../../../../../../features/field-service";

function coordinate(
  body: Record<string, unknown>,
  key: "latitude" | "longitude",
) {
  const value = body[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError(`${key} must be a number`);
  return value;
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/crm/contacts/[id]/locations/[locationId]">,
) {
  try {
    await assertCrmMutation(request);
    const [{ id, locationId }, body] = await Promise.all([
      context.params,
      jsonObject(request),
    ]);
    const updated = await withCurrentTenant("crm:write", (sql, session) =>
      updateServiceLocation(
        sql,
        session.userId,
        uuid(id, "Contact"),
        uuid(locationId, "Location"),
        {
          name: text(body.name, "Location name"),
          address: optionalText(body.address, "Address") ?? null,
          latitude: coordinate(body, "latitude"),
          longitude: coordinate(body, "longitude"),
          contactName: optionalText(body.contactName, "Contact name") ?? null,
          contactPhone:
            optionalText(body.contactPhone, "Contact phone") ?? null,
          contactEmail:
            optionalText(body.contactEmail, "Contact email") ?? null,
        },
      ),
    );
    if (!updated)
      return NextResponse.json(
        { error: "Location not found" },
        { status: 404 },
      );
    return NextResponse.json({ updated: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/crm/contacts/[id]/locations/[locationId]">,
) {
  try {
    await assertCrmMutation(request);
    const { id, locationId } = await context.params;
    const archived = await withCurrentTenant("crm:write", (sql, session) =>
      archiveServiceLocation(
        sql,
        session.userId,
        uuid(id, "Contact"),
        uuid(locationId, "Location"),
      ),
    );
    if (!archived)
      return NextResponse.json(
        { error: "Location not found" },
        { status: 404 },
      );
    return NextResponse.json({ archived: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
