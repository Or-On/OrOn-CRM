import { productMetadata } from "../../i18n/product-metadata";
import { AccessDenied } from "../../i18n/access-denied";
import { ProductHeading } from "../../i18n/product-heading";
import { redirect } from "next/navigation";

import {
  listAutomationRuns,
  listAutomations,
  listBroadcasts,
  tenantOperationalInsights,
} from "@or-on/crm";

import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import { OperationsPanel } from "../../features/operations";

export default async function OperationsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly create?: string;
    readonly tab?: string;
  }>;
}) {
  try {
    const { create, tab } = await searchParams;
    const data = await withCurrentTenant("crm:read", async (sql) => ({
      broadcasts: await listBroadcasts(sql),
      automations: await listAutomations(sql),
      runs: await listAutomationRuns(sql),
      insights: await tenantOperationalInsights(sql),
    }));
    return (
      <main className="page page--wide page--operations page--workspace-premium">
        <ProductHeading page="operations" premium />
        <OperationsPanel
          automations={data.automations}
          broadcasts={data.broadcasts}
          runs={data.runs}
          insights={data.insights}
          initialTab={
            tab === "automations" || tab === "history" ? tab : "campaigns"
          }
          {...(create === "campaign"
            ? { initialCreate: "campaigns" as const }
            : {})}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const generateMetadata = () => productMetadata("operations");
