import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getTenantSettings, listTasks, listTeamMembers } from "@or-on/crm";

import { AccessDenied } from "../../i18n/access-denied";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import { TasksWorkspace } from "../../features/tasks";

export default async function TasksPage() {
  try {
    const data = await withCurrentTenant("crm:read", async (sql) => {
      const [tasks, members, settings] = await Promise.all([
        listTasks(sql, { limit: 500 }),
        listTeamMembers(sql),
        getTenantSettings(sql),
      ]);
      return { tasks, members, settings };
    });
    return (
      <main className="page page--wide">
        <TasksWorkspace
          initialTasks={data.tasks}
          members={data.members}
          tenantTimeZone={data.settings.timezone}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const metadata: Metadata = {
  title: "Tasks",
  description: "Tenant task planning and delivery tracking.",
};
