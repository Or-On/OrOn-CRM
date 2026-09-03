import { productMetadata } from "../../i18n/product-metadata";
import { AccessDenied } from "../../i18n/access-denied";
import { ProductHeading } from "../../i18n/product-heading";
import { redirect } from "next/navigation";

import {
  listAutomationRuns,
  listAutomations,
  listBroadcasts,
} from "@or-on/crm";

import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import { OperationsPanel } from "../../features/operations";

export default async function OperationsPage() {
  try {
    const data = await withCurrentTenant("crm:read", async (sql) => ({
      broadcasts: await listBroadcasts(sql),
      automations: await listAutomations(sql),
      runs: await listAutomationRuns(sql),
    }));
    return (
      <main className="page page--wide">
        <ProductHeading page="operations" />
        <OperationsPanel
          automations={data.automations}
          broadcasts={data.broadcasts}
          runs={data.runs}
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
