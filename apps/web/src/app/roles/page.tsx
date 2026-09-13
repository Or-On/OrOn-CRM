import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { canonicalRoles, hasPermission, permissions } from "@or-on/auth";
import { listTeamMembers } from "@or-on/crm";

import { AccessDenied } from "../../i18n/access-denied";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import { RolesWorkspace, type RoleRecord } from "../../features/roles";

export const metadata: Metadata = { title: "Roles & Permissions" };

export default async function RolesPage() {
  try {
    const roleRecords = await withCurrentTenant(
      "members:manage",
      async (sql) => {
        const members = await listTeamMembers(sql);
        return canonicalRoles.map((role): RoleRecord => ({
          name: role,
          memberCount: members.filter((member) => member.role === role).length,
          permissions: permissions.filter((permission) =>
            hasPermission(role, permission),
          ),
        }));
      },
    );

    return (
      <main className="page page--wide">
        <RolesWorkspace allPermissions={permissions} roles={roleRecords} />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
