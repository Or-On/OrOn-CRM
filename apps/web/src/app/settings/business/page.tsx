import { redirect } from "next/navigation";
import {
  getTenantFeatureSnapshot,
  getTenantConfigurationState,
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
    const data = await withCurrentTenant(
      "tenant:manage",
      async (sql, session) => {
        const [features, processes, options, governance] = await Promise.all([
          getTenantFeatureSnapshot(sql),
          listTenantProcesses(sql),
          listTenantProcessOptions(sql),
          getTenantConfigurationState(sql, session.isSuperuser),
        ]);
        return { features, processes, options, governance };
      },
    );
    return (
      <main className="page page--wide page--workspace-premium">
        <PageHeader
          eyebrow={he ? "הגדרות" : "Settings"}
          title={he ? "הגדרת העסק" : "Business configuration"}
          description={
            he
              ? "התאימו יכולות ותהליכים לעסק, בדקו את חוויית הלקוח ושלחו לאישור לפני הפרסום."
              : "Tailor the workspace and workflows to this business, review the experience, and approve changes before publication."
          }
        />
        <BusinessConfiguration
          definitions={tenantFeatureRegistry}
          initialFeatures={data.features}
          initialProcesses={data.processes}
          initialGovernance={data.governance}
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
