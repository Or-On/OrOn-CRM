import { redirect } from "next/navigation";
import { listPlatformTenants } from "@or-on/crm";
import { AccessDenied } from "../../i18n/access-denied";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import { TenantWorkspace } from "../../features/tenants";
import { canManageTenants } from "../../features/tenant-administration";

export default async function TenantsPage() {
  try {
    const data = await withCurrentTenant(
      "platform:read",
      async (sql, session) => {
        if (!canManageTenants(session.isSuperuser, session.tenant.tenantId))
          throw new ForbiddenError("Forbidden");
        return {
          currentTenantId: session.tenant.tenantId,
          tenants: await listPlatformTenants(sql),
        };
      },
    );
    return (
      <main className="page page--wide page--tenants">
        <TenantWorkspace
          currentTenantId={data.currentTenantId}
          tenants={data.tenants}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
