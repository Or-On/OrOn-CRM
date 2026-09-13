import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AccessDenied } from "../../i18n/access-denied";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import { ProfileWorkspace } from "../../features/profile";

export const metadata: Metadata = { title: "Profile" };

export default async function ProfilePage() {
  try {
    const data = await withCurrentTenant("platform:read", (_sql, session) =>
      Promise.resolve({
        account: {
          email: session.email,
          ...(session.displayName === undefined
            ? {}
            : { displayName: session.displayName }),
          isSuperuser: session.isSuperuser,
        },
        tenant: {
          tenantName: session.tenant.tenantName,
          role: session.tenant.role,
        },
        membershipCount: session.memberships.length,
      }),
    );

    return (
      <main className="page page--wide">
        <ProfileWorkspace {...data} />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
