import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { hasPermission } from "@or-on/auth";
import { loadConfig } from "@or-on/config";
import {
  getTenantSettings,
  listExpensePage,
  summarizeExpenses,
  getCampaignWallet,
  getCampaignPaymentSource,
} from "@or-on/crm";

import { AccessDenied } from "../../i18n/access-denied";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import {
  FinanceWorkspace,
  type VoiceUsageEstimate,
} from "../../features/finance";
import { voiceClient } from "../../features/voice-server";

async function loadVoiceEstimates(enabled: boolean): Promise<{
  readonly available: boolean;
  readonly estimates: readonly VoiceUsageEstimate[];
}> {
  if (!enabled) return { available: false, estimates: [] };
  try {
    const response = await (
      await voiceClient("voice:read", { timeoutMs: 600 })
    ).listVoiceSessions();
    return {
      available: true,
      estimates: response.data.items.map((session) => ({
        id: session.session_id,
        createdAt: session.created_at,
        totalUsd: session.cost.total,
        durationSeconds:
          typeof session.usage.call_seconds === "number"
            ? session.usage.call_seconds
            : null,
        partial: (session.cost.unpriced?.length ?? 0) > 0,
      })),
    };
  } catch {
    return { available: false, estimates: [] };
  }
}

export default async function FinancePage() {
  try {
    const platformConfig = loadConfig(process.env, { service: "web" });
    const data = await withCurrentTenant(
      "tenant:manage",
      async (sql, session) => {
        const canReadVoice =
          session.isSuperuser ||
          hasPermission(session.tenant.role, "voice:read");
        const [expensePage, summary, settings, voice, wallet, paymentSource] =
          await Promise.all([
            listExpensePage(sql, { limit: 500 }),
            summarizeExpenses(sql),
            getTenantSettings(sql),
            loadVoiceEstimates(canReadVoice),
            getCampaignWallet(sql),
            getCampaignPaymentSource(sql),
          ]);
        return {
          expensePage,
          summary,
          defaultCurrency: settings.defaultCurrency,
          voice,
          wallet,
          paymentSource,
        };
      },
    );
    return (
      <main className="page page--wide">
        <FinanceWorkspace
          defaultCurrency={data.defaultCurrency}
          initialExpenses={data.expensePage.expenses}
          initialNextCursor={data.expensePage.nextCursor}
          initialSummary={data.summary}
          voiceEstimateAvailable={data.voice.available}
          voiceEstimates={data.voice.estimates}
          initialWallet={data.wallet}
          initialPaymentSource={data.paymentSource}
          realBillingEnabled={platformConfig.enableRealBilling}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const metadata: Metadata = {
  title: "Finance",
  description: "Tenant expenses and operational cost visibility.",
};
