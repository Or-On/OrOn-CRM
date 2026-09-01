import { redirect } from "next/navigation";

import { listAutomations, listBroadcasts } from "@or-on/crm";

import { UnauthenticatedError, withCurrentTenant } from "../../features/auth";
import { OperationsPanel } from "../../features/operations";

export default async function OperationsPage() {
  try {
    const broadcasts = await withCurrentTenant("crm:read", listBroadcasts);
    const automations = await withCurrentTenant("crm:read", listAutomations);
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
        <OperationsPanel automations={automations} broadcasts={broadcasts} />
      </main>
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
