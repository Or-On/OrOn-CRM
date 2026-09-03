import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { listConversations, overviewMetrics } from "@or-on/crm";
import { loadConfig } from "@or-on/config";
import { UnauthenticatedError, withCurrentTenant } from "../features/auth";
import { Overview } from "../features/overview";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await getTranslations("meta"))("overview"),
    robots: { index: false, follow: false },
  };
}

export default async function OverviewPage() {
  try {
    const data = await withCurrentTenant("crm:read", async (sql, session) => ({
      metrics: await overviewMetrics(sql),
      conversations: await listConversations(sql),
      tenantName: session.tenant.tenantName,
    }));
    const config = loadConfig(process.env, { service: "web" });
    return (
      <Overview {...data} realWhatsAppEnabled={config.enableRealWhatsApp} />
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError)
      redirect(`/${await getLocale()}`);
    throw error;
  }
}
