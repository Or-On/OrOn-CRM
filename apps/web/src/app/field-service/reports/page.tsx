import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  getFieldServiceFeatureState,
  getTenantSettings,
  listServiceReportPage,
} from "@or-on/crm";

import { AccessDenied } from "../../../i18n/access-denied";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../../features/auth";
import { ReportsWorkspace } from "../../../features/field-service";

export default async function ServiceReportsPage() {
  try {
    const data = await withCurrentTenant("field-service:read", async (sql) => {
      const feature = await getFieldServiceFeatureState(sql);
      if (!feature.effective)
        throw new ForbiddenError("Field service disabled");
      const [initialPage, settings] = await Promise.all([
        listServiceReportPage(sql, { limit: 50 }),
        getTenantSettings(sql),
      ]);
      return { initialPage, timezone: settings.timezone };
    });
    return (
      <main className="page page--wide page--field-service page--workspace-premium">
        <ReportsWorkspace {...data} />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const metadata: Metadata = {
  title: "Service reports",
  description: "Tenant-scoped field-service report history.",
};
