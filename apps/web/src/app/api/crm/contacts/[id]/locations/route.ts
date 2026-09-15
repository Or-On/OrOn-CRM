import { NextResponse } from "next/server";
import { createServiceLocation } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";
import {
  optionalText,
  text,
  uuid,
} from "../../../../../../features/field-service";

export async function POST(
  request: Request,
  context: RouteContext<"/api/crm/contacts/[id]/locations">,
) {
  try {
    await assertCrmMutation(request);
    const [{ id }, body] = await Promise.all([
      context.params,
      jsonObject(request),
    ]);
    const address = optionalText(body.address, "Address");
    const contactName = optionalText(body.contactName, "Contact name");
    const contactPhone = optionalText(body.contactPhone, "Contact phone");
    const contactEmail = optionalText(body.contactEmail, "Contact email");
    const coordinate = (key: "latitude" | "longitude") => {
      const value = body[key];
      if (value === undefined || value === null) return null;
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new TypeError(`${key} must be a number`);
      return value;
    };
    const locationId = await withCurrentTenant("crm:write", (sql) =>
      createServiceLocation(sql, {
        customerContactId: uuid(id, "Contact"),
        name: text(body.name, "Location name"),
        ...(address === undefined ? {} : { address }),
        latitude: coordinate("latitude"),
        longitude: coordinate("longitude"),
        ...(contactName === undefined ? {} : { contactName }),
        ...(contactPhone === undefined ? {} : { contactPhone }),
        ...(contactEmail === undefined ? {} : { contactEmail }),
      }),
    );
    return NextResponse.json({ locationId }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
