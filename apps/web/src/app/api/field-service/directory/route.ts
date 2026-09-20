import { NextResponse } from "next/server";
import {
  getServiceDirectory,
  requireTenantFeature,
  saveServiceDirectoryEntry,
} from "@or-on/crm";
import { jsonObject, withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";
import { optionalText, text, uuid } from "../../../../features/field-service";

export async function GET() {
  try {
    return NextResponse.json(
      await withCurrentTenant("field-service:manage", async (sql) => {
        await requireTenantFeature(sql, "field_service");
        return getServiceDirectory(sql);
      }),
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (body.kind !== "chain" && body.kind !== "store")
      throw new TypeError("Invalid directory entry kind");
    const kind = body.kind;
    const id = await withCurrentTenant("field-service:manage", async (sql) => {
      await requireTenantFeature(sql, "field_service");
      return saveServiceDirectoryEntry(sql, {
        kind,
        name: text(body.name, "Name"),
        chainId: body.chainId == null ? null : uuid(body.chainId, "Chain"),
        contactId:
          body.contactId == null ? null : uuid(body.contactId, "Contact"),
        address: optionalText(body.address, "Address") ?? null,
      });
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
