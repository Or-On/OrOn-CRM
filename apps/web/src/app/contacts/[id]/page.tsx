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
import { voiceClient } from "../../../features/voice-server";

async function optionalVoiceFlows() {
  try {
    const client = await voiceClient("voice:read", { timeoutMs: 1500 });
    const result = await client.listVoiceFlows();
    if (!result.ok || !Array.isArray(result.data.items))
      return { available: false, items: [] };
    return { available: true, items: result.data.items };
  } catch (error) {
    // Session expiry still redirects. Optional calling failure must not turn an
    // otherwise authorized contact record into an unavailable CRM page.
    if (error instanceof UnauthenticatedError) throw error;
    return { available: false, items: [] };
  }
}

export default async function ContactDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  try {
    const { id } = await params;
    const [{ activity, contact }, flows] = await Promise.all([
      withCurrentTenant("crm:read", async (sql) => ({
        contact: await getContactDetail(sql, id),
        activity: await listContactActivity(sql, id),
      })),
      optionalVoiceFlows(),
    ]);
    if (contact === undefined) notFound();
    return (
      <main className="page page--wide page--workspace-premium">
        <ProductHeading page="contact" premium />
        <ContactDetailPanel
          activity={activity}
          contact={contact}
          realVoiceEnabled={
            process.env.ENABLE_REAL_TELEPHONY?.toLowerCase() === "true" &&
            process.env.ENABLE_REAL_VOICE_PROVIDERS?.toLowerCase() === "true"
          }
          voiceAvailable={flows.available}
          voiceFlows={flows.items}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const generateMetadata = () => productMetadata("contact");
