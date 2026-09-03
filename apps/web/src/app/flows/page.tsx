import { productMetadata } from "../../i18n/product-metadata";
import { AccessDenied } from "../../i18n/access-denied";
import { ProductHeading } from "../../i18n/product-heading";
import { redirect } from "next/navigation";

import { ForbiddenError, UnauthenticatedError } from "../../features/auth";
import { VoiceFlowPanel } from "../../features/voice";
import { voiceClient } from "../../features/voice-server";

export default async function FlowsPage() {
  try {
    const client = await voiceClient("voice:read");
    const [catalog, flows] = await Promise.all([
      client.getVoiceComponentCatalog(),
      client.listVoiceFlows(),
    ]);
    return (
      <main className="page page--wide">
        <ProductHeading page="flows" />
        <VoiceFlowPanel catalog={catalog.data} flows={flows.data.items} />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const generateMetadata = () => productMetadata("flows");
