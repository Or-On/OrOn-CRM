import { redirect } from "next/navigation";

import {
  listAutomationRuns,
  listAutomations,
  listBroadcasts,
} from "@or-on/crm";

import { UnauthenticatedError, withCurrentTenant } from "../../features/auth";
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
        <header className="page-heading">
          <p className="eyebrow">Orchestration</p>
          <h1>Campaigns & automations</h1>
          <p>
            Safe simulator delivery and versioned automation drafts on canonical
            PostgreSQL.
          </p>
        </header>
        <OperationsPanel
          automations={data.automations}
          broadcasts={data.broadcasts}
          runs={data.runs}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
