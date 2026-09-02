import { redirect } from "next/navigation";

import {
  listAgentProfiles,
  listAutomations,
  listContactActivity,
  listContacts,
  listConversations,
  listHandoffs,
  listVoiceOutcomes,
  summarizeCrossChannelUsage,
} from "@or-on/crm";

import { UnauthenticatedError, withCurrentTenant } from "../../features/auth";
import { OrchestrationPanel } from "../../features/orchestration";

export default async function OrchestrationPage() {
  try {
    const data = await withCurrentTenant("crm:read", async (sql) => {
      const contacts = await listContacts(sql, { limit: 50 });
      return {
        agents: await listAgentProfiles(sql),
        flows: await listAutomations(sql),
        handoffs: await listHandoffs(sql),
        contacts,
        conversations: await listConversations(sql),
        usage: await summarizeCrossChannelUsage(sql),
        voiceOutcomes: await listVoiceOutcomes(sql),
        activity:
          contacts[0] === undefined
            ? []
            : await listContactActivity(sql, contacts[0].id),
      };
    });
    return (
      <main className="page page--wide">
        <header className="page-heading">
          <p className="eyebrow">Phase 6 · Cross-channel platform</p>
          <h1>Agents and orchestration</h1>
          <p>
            Versioned agent profiles, canonical voice/WhatsApp flows, durable
            simulator commands, human handoffs, and one safe activity view.
          </p>
        </header>
        <OrchestrationPanel {...data} />
      </main>
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
