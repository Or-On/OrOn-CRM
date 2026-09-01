import { redirect } from "next/navigation";

import {
  getTenantSettings,
  listApiKeys,
  listNotifications,
  listTeamMembers,
} from "@or-on/crm";

import { UnauthenticatedError, withCurrentTenant } from "../../features/auth";
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
      }),
    );
    return (
      <main className="page page--wide">
        <header className="page-heading">
          <p className="eyebrow">Workspace administration</p>
          <h1>Settings & team</h1>
          <p>
            Tenant preferences, canonical members, notifications, and provider
            safety.
          </p>
        </header>
        <ManagementPanel {...data} />
      </main>
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
