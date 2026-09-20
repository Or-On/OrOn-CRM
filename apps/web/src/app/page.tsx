import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import {
  dashboardMetrics,
  overviewMetrics,
  overviewInsights,
  tenantOperationalInsights,
  getTenantFeatureSnapshot,
  countLeads,
} from "@or-on/crm";
import { isAuthorized } from "@or-on/auth";
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
    const data = await withCurrentTenant(
      "platform:read",
      async (sql, session) => {
        const features = await getTenantFeatureSnapshot(sql);
        if (
          session.tenant.role === "technician" &&
          features.field_service.effective
        )
          return { technician: true as const };
        if (
          !isAuthorized(
            { role: session.tenant.role, isSuperuser: session.isSuperuser },
            "crm:read",
          )
        )
          throw new ForbiddenError("Workspace access is unavailable");
        const metrics = await overviewMetrics(sql);
        const dashboard = await dashboardMetrics(sql);
        const insights = await overviewInsights(sql);
        const operations = await tenantOperationalInsights(sql);
        const leadCounts = features.leads.effective
          ? await countLeads(sql, { status: "all" })
          : undefined;
        return {
          dashboard,
          metrics,
          insights,
          operations,
          tenantName: session.tenant.tenantName,
          enabledFeatures: Object.values(features)
            .filter((feature) => feature.effective)
            .map((feature) => feature.key),
          ...(leadCounts === undefined ? {} : { leadCount: leadCounts.total }),
        };
      },
    );
    if ("technician" in data) redirect("/field-service");
    return <Overview {...data} />;
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
