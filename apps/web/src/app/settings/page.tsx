import { productMetadata } from "../../i18n/product-metadata";
import { AccessDenied } from "../../i18n/access-denied";
import { ProductHeading } from "../../i18n/product-heading";
import { redirect } from "next/navigation";
import { hasPermission } from "@or-on/auth";

import {
  getTenantSettings,
  listApiKeys,
  listTenantInvitations,
  listNotifications,
  listTeamMembers,
} from "@or-on/crm";

import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import { ManagementPanel } from "../../features/management";

export default async function SettingsPage() {
  try {
    const data = await withCurrentTenant(
      "platform:read",
      async (sql, session) => {
        const canManageMembers =
          session.isSuperuser ||
          hasPermission(session.tenant.role, "members:manage");
        const canManageTenant =
          session.isSuperuser ||
          hasPermission(session.tenant.role, "tenant:manage");
        return {
          members: canManageMembers ? await listTeamMembers(sql) : [],
          invitations: canManageMembers ? await listTenantInvitations(sql) : [],
          notifications: await listNotifications(sql, session.userId),
          apiKeys: canManageTenant ? await listApiKeys(sql) : [],
          settings: canManageTenant ? await getTenantSettings(sql) : undefined,
          canManageMembers,
          canManageTenant,
          canManageOwners:
            session.isSuperuser || session.tenant.role === "owner",
          tenantName: canManageTenant ? session.tenant.tenantName : undefined,
          currentUserId: session.userId,
          account: {
            email: session.email,
            ...(session.displayName === undefined
              ? {}
              : { displayName: session.displayName }),
            isSuperuser: session.isSuperuser,
          },
        };
      },
    );
    return (
      <main className="page page--wide page--settings page--workspace-premium">
        <ProductHeading page="settings" premium />
        <ManagementPanel {...data} />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const generateMetadata = () => productMetadata("settings");
