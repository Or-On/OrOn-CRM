import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { listConversations, overviewMetrics } from "@or-on/crm";
import { loadConfig } from "@or-on/config";
import { UnauthenticatedError, withCurrentTenant } from "../features/auth";
import { Overview } from "../features/overview";

export const metadata: Metadata = { title: "Overview" };

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
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
