import { redirect } from "next/navigation";

import { listPipelineBoards } from "@or-on/crm";

import { UnauthenticatedError, withCurrentTenant } from "../../features/auth";
import { PipelineBoard } from "../../features/pipelines";

export default async function PipelinesPage() {
  try {
    const boards = await withCurrentTenant("crm:read", (sql) =>
      listPipelineBoards(sql),
    );
    return (
      <main className="page page--wide">
        <header className="page-heading">
          <p className="eyebrow">Revenue operations</p>
          <h1>Pipeline</h1>
          <p>Persisted deals organized by canonical tenant-owned stages.</p>
        </header>
        <PipelineBoard boards={boards} />
      </main>
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
