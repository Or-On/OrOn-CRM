import { Activity, Boxes, DatabaseZap } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Badge, Surface } from "@or-on/ui";

import { currentPublicSession } from "../features/auth";

export const metadata: Metadata = { title: "Foundation" };

const foundations = [
  {
    icon: DatabaseZap,
    title: "One PostgreSQL authority",
    body: "Alembic owns schema history. Tenant isolation remains aligned with transaction-local context and fail-closed RLS.",
  },
  {
    icon: Boxes,
    title: "Working engines preserved",
    body: "Voice, CRM, messaging, and browser-local AI will enter through thin adapters—not wholesale rewrites.",
  },
  {
    icon: Activity,
    title: "Operational truth",
    body: "Liveness describes the process. Readiness reflects mandatory dependencies instead of returning a decorative green light.",
  },
] as const;

export default async function FoundationPage() {
  const session = await currentPublicSession();
  if (session === undefined) redirect("/login");
  return (
    <main>
      <header className="page-header">
        <div>
          <span className="eyebrow">
            {session.tenant.tenantName} · secure workspace
          </span>
          <h1>One identity. Tenant-safe operations.</h1>
        </div>
        <div>
          <Badge label="Foundation active" tone="positive" />
          <p>
            The shell, contracts, service boundaries, and PostgreSQL authority
            are being proven. Product modules are intentionally unavailable
            until their source behavior is ported.
          </p>
        </div>
      </header>

      <div className="foundation-grid">
        {foundations.map(({ body, icon: Icon, title }) => (
          <Surface className="foundation-card" key={title} level="raised">
            <Icon aria-hidden="true" size={22} strokeWidth={1.7} />
            <h2>{title}</h2>
            <p>{body}</p>
          </Surface>
        ))}
      </div>
    </main>
  );
}
