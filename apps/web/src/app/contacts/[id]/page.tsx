import { notFound, redirect } from "next/navigation";

import { getContactDetail } from "@or-on/crm";

import {
  UnauthenticatedError,
  withCurrentTenant,
} from "../../../features/auth";
import { ContactDetailPanel } from "../../../features/contacts";

export default async function ContactDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  try {
    const { id } = await params;
    const contact = await withCurrentTenant("crm:read", (sql) =>
      getContactDetail(sql, id),
    );
    if (contact === undefined) notFound();
    return (
      <main className="page page--wide">
        <header className="page-heading">
          <p className="eyebrow">Contact record</p>
          <h1>{contact.name}</h1>
          <p>Identity, notes, and tenant-owned relationship context.</p>
        </header>
        <ContactDetailPanel contact={contact} />
      </main>
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
