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
  readonly searchParams: Promise<{
    readonly create?: string;
    readonly q?: string;
  }>;
}) {
  try {
    const { create, q } = await searchParams;
    const contacts = await withCurrentTenant("crm:read", (sql) =>
      listContacts(sql, q === undefined ? {} : { query: q }),
    );
    return (
      <main className="page page--wide page--workspace-premium">
        <ProductHeading page="contacts" premium />
        <ContactManager
          contacts={contacts}
          query={q ?? ""}
          {...(create === "1" ? { initialPanel: "create" as const } : {})}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const generateMetadata = () => productMetadata("contacts");
