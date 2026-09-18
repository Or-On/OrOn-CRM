import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import {
  getContact,
  getTenantSettings,
  getTicketDetail,
  requireTenantFeature,
  TenantFeatureDisabledError,
} from "@or-on/crm";

import { AccessDenied } from "../../../i18n/access-denied";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../../features/auth";
import { TicketDetailView } from "../../../features/tickets";

export default async function TicketDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  try {
    const data = await withCurrentTenant("crm:read", async (sql) => {
      await requireTenantFeature(sql, "tickets");
      const detail = await getTicketDetail(sql, id);
      if (detail === undefined) return undefined;
      const [contact, settings] = await Promise.all([
        getContact(sql, detail.ticket.contactId),
        getTenantSettings(sql),
      ]);
      return { contact, detail, settings };
    });
    if (data === undefined) notFound();
    return (
      <main className="page page--wide">
        <TicketDetailView
          contactName={data.contact?.name ?? data.detail.ticket.contactId}
          detail={data.detail}
          tenantTimeZone={data.settings.timezone}
        />
      </main>
    );
  } catch (error) {
    if (
      error instanceof ForbiddenError ||
      error instanceof TenantFeatureDisabledError
    )
      return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const metadata: Metadata = {
  title: "Ticket",
  description: "One customer issue with its messages, calls and evidence.",
};
