import { redirect } from "next/navigation";

import { listContacts } from "@or-on/crm";

import { UnauthenticatedError, withCurrentTenant } from "../../features/auth";
import { ContactManager } from "../../features/contacts";

export default async function ContactsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly q?: string }>;
}) {
  try {
    const { q } = await searchParams;
    const contacts = await withCurrentTenant("crm:read", (sql) =>
      listContacts(sql, q === undefined ? {} : { query: q }),
    );
    return (
      <main className="page page--wide">
        <header className="page-heading">
          <p className="eyebrow">Customer graph</p>
          <h1>Contacts</h1>
          <p>
            One tenant-safe identity for every relationship across messaging and
            future voice channels.
          </p>
        </header>
        <ContactManager contacts={contacts} />
      </main>
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
