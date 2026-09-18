import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getTenantSettings, listContacts, listTickets } from "@or-on/crm";

import { AccessDenied } from "../../i18n/access-denied";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import { TicketsWorkspace } from "../../features/tickets";

export default async function TicketsPage() {
  try {
    const data = await withCurrentTenant("crm:read", async (sql) => {
      const [page, contacts, settings] = await Promise.all([
        listTickets(sql, { status: "open", limit: 25 }),
        listContacts(sql, { limit: 500 }),
        getTenantSettings(sql),
      ]);
      return { page, contacts, settings };
    });
    // Names are resolved here so the browser receives only the names belonging
    // to the page it is showing, never the tenant's contact table.
    const contactNames = Object.fromEntries(
      data.contacts.map((contact) => [contact.id, contact.name]),
    );
    return (
      <main className="page page--wide">
        <TicketsWorkspace
          contactNames={contactNames}
          initialPage={data.page}
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
  title: "Tickets",
  description: "Customer support issues across WhatsApp, voice and human work.",
};
