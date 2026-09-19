import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { getLeadDetail, getTenantSettings, listTeamMembers } from "@or-on/crm";

import { AccessDenied } from "../../../i18n/access-denied";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../../features/auth";
import { LeadDetailView } from "../../../features/leads";

export default async function LeadDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  try {
    const data = await withCurrentTenant("crm:read", async (sql) => {
      const detail = await getLeadDetail(sql, id);
      if (detail === undefined) return undefined;
      const [team, settings] = await Promise.all([
        listTeamMembers(sql),
        getTenantSettings(sql),
      ]);
      return { detail, team, settings };
    });
    if (data === undefined) notFound();
    return (
      <main className="page page--wide">
        <LeadDetailView
          detail={data.detail}
          team={data.team.map((member) => ({
            userId: member.userId,
            name: member.displayName ?? member.email,
          }))}
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
  title: "Lead",
  description:
    "One commercial interest with the fields collected for it and where each came from.",
};
