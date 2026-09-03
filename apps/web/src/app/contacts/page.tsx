import { productMetadata } from "../../i18n/product-metadata";
import { AccessDenied } from "../../i18n/access-denied";
import { ProductHeading } from "../../i18n/product-heading";
import { redirect } from "next/navigation";

import { listContacts } from "@or-on/crm";

import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
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
        <ProductHeading page="contacts" />
        <ContactManager contacts={contacts} query={q ?? ""} />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const generateMetadata = () => productMetadata("contacts");
