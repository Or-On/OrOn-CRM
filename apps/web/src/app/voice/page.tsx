import { redirect } from "next/navigation";

import { UnauthenticatedError } from "../../features/auth";
import { voiceClient, VoiceOverview } from "../../features/voice";

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
      <main className="page page--wide">
        <header className="page-heading">
          <p className="eyebrow">Voice control plane</p>
          <h1>Calls & phone numbers</h1>
          <p>
            Canonical PostgreSQL call state, safe SIP admission, and
            deterministic simulator diagnostics.
          </p>
        </header>
        <VoiceOverview
          flows={flows.data.items}
          numbers={numbers.data.items}
          reconciliation={reconciliation.data}
          sessions={sessions.data.items}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
