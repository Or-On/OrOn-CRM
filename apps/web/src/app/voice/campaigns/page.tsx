import { redirect } from "next/navigation";

import { UnauthenticatedError } from "../../../features/auth";
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
        <header className="page-heading">
          <p className="eyebrow">Voice outreach</p>
          <h1>Voice campaigns</h1>
          <p>
            Consent-aware CRM audiences with bounded concurrency, calling
            windows, and idempotent simulator runs.
          </p>
        </header>
        <VoiceCampaignPanel
          campaigns={campaigns.data.items}
          flows={flows.data.items}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
