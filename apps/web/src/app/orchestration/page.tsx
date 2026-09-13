import { productMetadata } from "../../i18n/product-metadata";
import { AccessDenied } from "../../i18n/access-denied";
import { ProductHeading } from "../../i18n/product-heading";
import { redirect } from "next/navigation";

import {
  listAgentProfiles,
  listAutomationRuns,
  tenantOperationalInsights,
  listAutomations,
  listContactActivity,
  listContacts,
  listConversations,
  listHandoffs,
  listVoiceOutcomes,
  summarizeCrossChannelUsage,
} from "@or-on/crm";

import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import { OrchestrationPanel } from "../../features/orchestration";

export default async function OrchestrationPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly contact?: string;
    readonly tab?: string;
  }>;
}) {
  try {
    const { contact: requested, tab } = await searchParams;
    const initialTab =
      tab === "flows" || tab === "activity" || tab === "handoffs"
        ? tab
        : "agents";
    const data = await withCurrentTenant("crm:read", async (sql) => {
      const contacts = await listContacts(sql, { limit: 50 });
      const selected =
        contacts.find((contact) => contact.id === requested) ?? contacts[0];
      return {
        agents: await listAgentProfiles(sql),
        runs: await listAutomationRuns(sql),
        insights: await tenantOperationalInsights(sql),
        flows: await listAutomations(sql),
        handoffs: await listHandoffs(sql),
        contacts,
        ...(selected ? { activityContactId: selected.id } : {}),
        conversations: await listConversations(sql),
        usage: await summarizeCrossChannelUsage(sql),
        voiceOutcomes: await listVoiceOutcomes(sql),
        activity:
          selected === undefined
            ? []
            : await listContactActivity(sql, selected.id),
      };
    });
    return (
      <main className="page page--wide page--workspace-premium">
        <ProductHeading page="orchestration" premium />
        <OrchestrationPanel {...data} initialTab={initialTab} />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const generateMetadata = () => productMetadata("orchestration");
