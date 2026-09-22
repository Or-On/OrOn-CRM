import { NextResponse } from "next/server";
import { listContacts, requireFieldService } from "@or-on/crm";

import { withCurrentTenant } from "../../../../features/auth";
import { crmErrorResponse } from "../../../../features/crm-route";

/**
 * Customer lookup for opening a service case. Technicians work without CRM
 * access, so this returns only what the case form needs: no channel
 * identities, consent state, tags or activity.
 */
export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    if (query.length > 120) throw new TypeError("Customer search is too long");
    const contacts = await withCurrentTenant(
      "field-service:operate",
      async (sql) => {
        await requireFieldService(sql);
        return listContacts(sql, { query, limit: 50 });
      },
    );
    return NextResponse.json(
      {
        contacts: contacts.map(({ id, name, company }) => ({
          id,
          name,
          company,
        })),
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
