import { redirect } from "next/navigation";

import { UnauthenticatedError } from "../../features/auth";
import { voiceClient, VoiceFlowPanel } from "../../features/voice";

export default async function FlowsPage() {
  try {
    const client = await voiceClient("voice:read");
    const [catalog, flows] = await Promise.all([
      client.getVoiceComponentCatalog(),
      client.listVoiceFlows(),
    ]);
    return (
      <main className="page page--wide">
        <header className="page-heading">
          <p className="eyebrow">Versioned execution</p>
          <h1>Voice flows</h1>
          <p>
            Author, validate, and publish immutable Pipecat-compatible voice
            definitions.
          </p>
        </header>
        <VoiceFlowPanel catalog={catalog.data} flows={flows.data.items} />
      </main>
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
