import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  getServiceWorkflowPolicy,
  getTenantSettings,
  listContacts,
  listTickets,
  summarizeTicketOutcomes,
  requireTenantFeature,
  TenantFeatureDisabledError,
} from "@or-on/crm";

import { AccessDenied } from "../../i18n/access-denied";
import { ProductHeading } from "../../i18n/product-heading";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import { TicketsWorkspace } from "../../features/tickets";

export default async function TicketsPage() {
  try {
    const until = new Date();
    const since = new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000);
    const data = await withCurrentTenant("crm:read", async (sql) => {
      await requireTenantFeature(sql, "tickets");
      const [page, contacts, settings, metrics, policy] = await Promise.all([
        listTickets(sql, { status: "open", limit: 25 }),
        listContacts(sql, { limit: 500 }),
        getTenantSettings(sql),
        // Aggregate outcomes live on the register, never on a single ticket.
        summarizeTicketOutcomes(sql, {
          since: since.toISOString(),
          until: until.toISOString(),
        }),
        getServiceWorkflowPolicy(sql),
      ]);
      const emergencyLabel =
        policy.emergency?.enabled === true ? policy.emergency.label : null;
      return { page, contacts, settings, metrics, emergencyLabel };
    });
    // Names are resolved here so the browser receives only the names belonging
    // to the page it is showing, never the tenant's contact table.
    const contactNames = Object.fromEntries(
      data.contacts.map((contact) => [contact.id, contact.name]),
    );
    return (
      <main className="page page--wide page--workspace-premium">
        <ProductHeading page="tickets" premium />
        <TicketsWorkspace
          contactNames={contactNames}
          emergencyLabel={data.emergencyLabel}
          initialPage={data.page}
          metrics={data.metrics}
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
  title: "Tickets",
  description: "Customer support issues across WhatsApp, voice and human work.",
};
