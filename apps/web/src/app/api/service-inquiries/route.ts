import { NextResponse } from "next/server";
import {
  getTenantSettings,
  listServiceInquiries,
  type ServiceInquiryStatus,
} from "@or-on/crm";
import { withCurrentTenant, ForbiddenError } from "../../../features/auth";
import { isAuthorized } from "@or-on/auth";
import { crmErrorResponse } from "../../../features/crm-route";

export async function GET(request: Request) {
  try {
    const parameters = new URL(request.url).searchParams;
    const result = await withCurrentTenant("crm:read", async (sql, session) => {
      if (
        !isAuthorized(
          { role: session.tenant.role, isSuperuser: session.isSuperuser },
          "field-service:read",
        )
      )
        throw new ForbiddenError("Field service access is unavailable");
      const settings = await getTenantSettings(sql);
      return listServiceInquiries(sql, {
        timezone: settings.timezone,
        ...(parameters.has("status")
          ? {
              status: parameters.get("status") as ServiceInquiryStatus | "all",
            }
          : {}),
        ...Object.fromEntries(
          ["query", "since", "until", "beforeOpenedAt", "beforeId"].flatMap(
            (key) => {
              const value = parameters.get(key === "query" ? "q" : key);
              return value === null ? [] : [[key, value]];
            },
          ),
        ),
      });
    });
    return NextResponse.json(result);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
