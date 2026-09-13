import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import {
  dashboardMetrics,
  overviewMetrics,
  overviewInsights,
  tenantOperationalInsights,
} from "@or-on/crm";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../features/auth";
import { AccessDenied } from "../i18n/access-denied";
import { Overview } from "../features/overview";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await getTranslations("meta"))("overview"),
    robots: { index: false, follow: false },
  };
}

export default async function OverviewPage() {
  try {
    const data = await withCurrentTenant("crm:read", async (sql, session) => {
      const metrics = await overviewMetrics(sql);
      const dashboard = await dashboardMetrics(sql);
      const insights = await overviewInsights(sql);
      const operations = await tenantOperationalInsights(sql);
      return {
        dashboard,
        metrics,
        insights,
        operations,
        tenantName: session.tenant.tenantName,
      };
    });
    return <Overview {...data} />;
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
