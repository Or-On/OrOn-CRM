import { redirect } from "next/navigation";
import {
  getTenantFeatureSnapshot,
  listTenantProcesses,
  listTenantProcessOptions,
  tenantFeatureRegistry,
  tenantTemplateRegistry,
} from "@or-on/crm";
import { PageHeader } from "@or-on/ui";
import { getLocale } from "next-intl/server";

import { BusinessConfiguration } from "../../../features/business-configuration";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../../features/auth";
import { AccessDenied } from "../../../i18n/access-denied";

export default async function BusinessConfigurationPage() {
  try {
    const locale = await getLocale();
    const he = locale.startsWith("he");
    const data = await withCurrentTenant("tenant:manage", async (sql) => {
      const [features, processes, options] = await Promise.all([
        getTenantFeatureSnapshot(sql),
        listTenantProcesses(sql),
        listTenantProcessOptions(sql),
      ]);
      return { features, processes, options };
    });
    return (
      <main className="page page--wide page--workspace-premium">
        <PageHeader
          eyebrow={he ? "הגדרות" : "Settings"}
          title={he ? "הגדרת העסק" : "Business configuration"}
          description={
            he
              ? "בחרו את המודולים הזמינים בסביבת העבודה, ואז שייכו אירועי לקוח לגרסאות מדויקות שפורסמו של סוכנים ו-Flows."
              : "Choose the modules this workspace can use, then bind customer events to exact published Agents and Flows."
          }
        />
        <BusinessConfiguration
          definitions={tenantFeatureRegistry}
          initialFeatures={data.features}
          initialProcesses={data.processes}
          options={data.options}
          templates={tenantTemplateRegistry}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const metadata = { title: "Business configuration" };
