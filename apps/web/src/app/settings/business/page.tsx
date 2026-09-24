import { redirect } from "next/navigation";
import {
  getTenantFeatureSnapshot,
  getTenantConfigurationState,
  listTenantProcesses,
  listTenantProcessOptions,
  tenantFeatureRegistry,
  tenantTemplateRegistry,
} from "@or-on/crm";

import { BusinessConfiguration } from "../../../features/business-configuration";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../../features/auth";
import { AccessDenied } from "../../../i18n/access-denied";
import { ProductHeading } from "../../../i18n/product-heading";

export default async function BusinessConfigurationPage() {
  try {
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
      <main className="page page--wide page--settings page--workspace-premium">
        <ProductHeading page="businessConfiguration" premium />
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
