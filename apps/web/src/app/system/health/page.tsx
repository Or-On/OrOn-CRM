import type { Metadata } from "next";

import { HealthPanel } from "../../../features/system-health";

export const metadata: Metadata = { title: "System health" };

export default function SystemHealthPage() {
  return (
    <main>
      <header className="page-header">
        <div>
          <span className="eyebrow">Development diagnostics</span>
          <h1>System health</h1>
        </div>
        <p>
          Live data from the same-origin façade. Readiness fails when mandatory
          PostgreSQL connectivity is unavailable.
        </p>
      </header>
      <HealthPanel />
    </main>
  );
}
