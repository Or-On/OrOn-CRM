import { productMetadata } from "../../i18n/product-metadata";
import { AccessDenied } from "../../i18n/access-denied";
import { ProductHeading } from "../../i18n/product-heading";
import { redirect } from "next/navigation";

import { listContactPage, listCustomerClassifications } from "@or-on/crm";

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
    const { classifications, contactPage } = await withCurrentTenant(
      "crm:read",
      async (sql) => {
        const [contactPage, classifications] = await Promise.all([
          listContactPage(sql, {
            ...(q === undefined ? {} : { query: q }),
            limit: 50,
          }),
          listCustomerClassifications(sql),
        ]);
        return { contactPage, classifications };
      },
    );
    return (
      <main className="page page--wide page--workspace-premium">
        <ProductHeading page="contacts" premium />
        <ContactManager
          contacts={contactPage.contacts}
          nextCursor={contactPage.nextCursor}
          classifications={classifications}
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
