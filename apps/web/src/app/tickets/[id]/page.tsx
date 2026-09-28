import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import {
  getContact,
  getTenantFeatureSnapshot,
  usesServiceManagerExperience,
  listServiceInquiries,
  getServiceCaseDossier,
  getInquiryDetail,
  getServiceWorkflowPolicy,
  getTenantSettings,
  getTicketDetail,
  listTeamMembers,
  requireTenantFeature,
  TenantFeatureDisabledError,
} from "@or-on/crm";

import { isAuthorized } from "@or-on/auth";
import { ServiceInquiryDetail } from "../../../features/service-manager";
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
    const data = await withCurrentTenant("crm:read", async (sql, session) => {
      await requireTenantFeature(sql, "tickets");
      const detail = await getTicketDetail(sql, id);
      if (detail === undefined) return undefined;
      const [contact, settings, inquiry, policy, members] = await Promise.all([
        getContact(sql, detail.ticket.contactId),
        getTenantSettings(sql),
        getInquiryDetail(sql, id),
        getServiceWorkflowPolicy(sql),
        detail.ticket.ownerUserId === null
          ? Promise.resolve([])
          : listTeamMembers(sql),
      ]);
      const features = await getTenantFeatureSnapshot(sql);
      const serviceManager = usesServiceManagerExperience(features);
      const serviceInquiry = serviceManager
        ? (await listServiceInquiries(sql, { id, timezone: settings.timezone }))
            .inquiries[0]
        : undefined;
      const canReadField = isAuthorized(
        { role: session.tenant.role, isSuperuser: session.isSuperuser },
        "field-service:read",
      );
      const dossier =
        serviceManager && canReadField && detail.ticket.serviceCaseId !== null
          ? await getServiceCaseDossier(sql, detail.ticket.serviceCaseId)
          : undefined;
      const owner = members.find(
        (member) => member.userId === detail.ticket.ownerUserId,
      );
      const emergency = policy.emergency;
      return {
        serviceInquiry,
        dossier,
        canResolve: isAuthorized(
          { role: session.tenant.role, isSuperuser: session.isSuperuser },
          "field-service:manage",
        ),
        contact,
        detail,
        ownerName: owner?.displayName ?? owner?.email ?? null,
        settings,
        inquiry: inquiry ?? null,
        emergencyLabel: emergency?.enabled === true ? emergency.label : null,
        // The database decides; this only avoids offering an action the
        // role or tenant setting would refuse.
        canMarkEmergency:
          emergency?.manualRedCall === true &&
          ["owner", "admin", "agent"].includes(session.tenant.role),
      };
    });
    if (data === undefined) notFound();
    if (data.serviceInquiry !== undefined)
      return (
        <main className="page page--wide">
          <ServiceInquiryDetail
            item={data.serviceInquiry}
            inquiry={data.inquiry}
            attachments={data.dossier?.attachments ?? []}
            timezone={data.settings.timezone}
            canResolve={data.canResolve}
            ticket={data.detail.ticket}
            emergencyLabel={data.emergencyLabel}
            canMarkEmergency={data.canMarkEmergency}
          />
        </main>
      );
    return (
      <main className="page page--wide page--workspace-premium">
        <TicketDetailView
          canMarkEmergency={data.canMarkEmergency}
          contactName={data.contact?.name ?? data.detail.ticket.contactId}
          detail={data.detail}
          ownerName={data.ownerName}
          emergencyLabel={data.emergencyLabel}
          inquiry={data.inquiry}
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
