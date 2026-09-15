import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { listTeamMembers, listTenantInvitations } from "@or-on/crm";

import { AccessDenied } from "../../i18n/access-denied";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import { UsersWorkspace } from "../../features/users";

export const metadata: Metadata = { title: "Users" };

type UserRoleFilter =
  "owner" | "admin" | "agent" | "technician" | "viewer" | "all";

function roleFilter(value: string | string[] | undefined): UserRoleFilter {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate === "owner" ||
    candidate === "admin" ||
    candidate === "agent" ||
    candidate === "technician" ||
    candidate === "viewer"
    ? candidate
    : "all";
}

export default async function UsersPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly role?: string | string[] | undefined;
  }>;
}) {
  try {
    const query = await searchParams;
    const data = await withCurrentTenant(
      "members:manage",
      async (sql, session) => ({
        members: await listTeamMembers(sql),
        invitations: await listTenantInvitations(sql),
        currentUserId: session.userId,
        canManageOwners: session.isSuperuser || session.tenant.role === "owner",
      }),
    );

    return (
      <main className="page page--wide">
        <UsersWorkspace {...data} initialRole={roleFilter(query.role)} />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
