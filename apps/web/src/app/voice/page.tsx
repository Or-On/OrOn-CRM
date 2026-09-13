import { productMetadata } from "../../i18n/product-metadata";
import { AccessDenied } from "../../i18n/access-denied";
import { ProductHeading } from "../../i18n/product-heading";
import { redirect } from "next/navigation";

import { ForbiddenError, UnauthenticatedError } from "../../features/auth";
import { VoiceOverview } from "../../features/voice";
import { voiceClient } from "../../features/voice-server";

export default async function VoicePage() {
  try {
    const client = await voiceClient("voice:read");
    const [sessions, numbers, flows, reconciliation] = await Promise.all([
      client.listVoiceSessions(),
      client.listVoicePhoneNumbers(),
      client.listVoiceFlows(),
      client.reconcileVoicePhoneNumbers(),
    ]);
    return (
      <main className="page page--wide page--workspace-premium">
        <ProductHeading page="voice" premium />
        <VoiceOverview
          flows={flows.data.items}
          numbers={numbers.data.items}
          reconciliation={reconciliation.data}
          sessions={sessions.data.items}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const generateMetadata = () => productMetadata("voice");
