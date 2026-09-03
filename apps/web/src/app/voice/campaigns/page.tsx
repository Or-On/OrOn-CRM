import { productMetadata } from "../../../i18n/product-metadata";
import { AccessDenied } from "../../../i18n/access-denied";
import { ProductHeading } from "../../../i18n/product-heading";
import { redirect } from "next/navigation";

import { ForbiddenError, UnauthenticatedError } from "../../../features/auth";
import { VoiceCampaignPanel } from "../../../features/voice";
import { voiceClient } from "../../../features/voice-server";

export default async function VoiceCampaignsPage() {
  try {
    const client = await voiceClient("voice:read");
    const [campaigns, flows] = await Promise.all([
      client.listVoiceCampaigns(),
      client.listVoiceFlows(),
    ]);
    return (
      <main className="page page--wide">
        <ProductHeading page="voiceCampaigns" />
        <VoiceCampaignPanel
          campaigns={campaigns.data.items}
          flows={flows.data.items}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const generateMetadata = () => productMetadata("voiceCampaigns");
