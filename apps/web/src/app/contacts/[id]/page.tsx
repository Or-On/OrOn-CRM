import { productMetadata } from "../../../i18n/product-metadata";
import { AccessDenied } from "../../../i18n/access-denied";
import { ProductHeading } from "../../../i18n/product-heading";
import { notFound, redirect } from "next/navigation";

import { getContactDetail, listContactActivity } from "@or-on/crm";

import {
  ForbiddenError,
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
    const { activity, contact } = await withCurrentTenant(
      "crm:read",
      async (sql) => ({
        contact: await getContactDetail(sql, id),
        activity: await listContactActivity(sql, id),
      }),
    );
    if (contact === undefined) notFound();
    return (
      <main className="page page--wide">
        <ProductHeading page="contact" />
        <ContactDetailPanel activity={activity} contact={contact} />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const generateMetadata = () => productMetadata("contact");
