import { productMetadata } from "../../i18n/product-metadata";
import { AccessDenied } from "../../i18n/access-denied";
import { ProductHeading } from "../../i18n/product-heading";
import { redirect } from "next/navigation";
import { loadConfig } from "@or-on/config";
import { hasPermission } from "@or-on/auth";

import {
  getTenantSettings,
  listApiKeys,
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
      async (sql, session) => ({
        settings: await getTenantSettings(sql),
        members: await listTeamMembers(sql),
        notifications: await listNotifications(sql, session.userId),
        apiKeys: await listApiKeys(sql),
        canManage: hasPermission(session.tenant.role, "tenant:manage"),
      }),
    );
    return (
      <main className="page page--wide">
        <ProductHeading page="settings" />
        <ManagementPanel
          {...data}
          realWhatsAppEnabled={
            loadConfig(process.env, { service: "web" }).enableRealWhatsApp
          }
        />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const generateMetadata = () => productMetadata("settings");
