"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge, Button, ErrorState, LoadingSkeleton, Surface } from "@or-on/ui";

interface HealthSnapshot {
  readonly checkedAt: string;
  readonly controlApi: {
    readonly liveness: { readonly ok: boolean; readonly status: number };
    readonly readiness: {
      readonly data: { readonly dependencies: { readonly postgres: string } };
      readonly ok: boolean;
      readonly status: number;
    };
  } | null;
  readonly error?: string;
}

export function HealthPanel() {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/system/health", { cache: "no-store" });
      setSnapshot((await response.json()) as HealthSnapshot);
    } catch {
      setSnapshot({
        checkedAt: new Date().toISOString(),
        controlApi: null,
        error: "health façade unavailable",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading && snapshot === null)
    return <LoadingSkeleton label="Checking service health" />;
  if (snapshot?.controlApi === null) {
    return (
      <ErrorState
        action={<Button onClick={() => void refresh()}>Check again</Button>}
        description="The control API could not be reached. Start the local Python service and PostgreSQL."
        title="Control API unavailable"
      />
    );
  }
  if (snapshot === null) return null;

  const postgres = snapshot.controlApi.readiness.data.dependencies.postgres;
  return (
    <div aria-live="polite" className="health-stack">
      <Surface className="health-row" level="raised">
        <div>
          <h2>Control API process</h2>
          <p>
            HTTP {snapshot.controlApi.liveness.status} · checked{" "}
            {snapshot.checkedAt}
          </p>
        </div>
        <Badge
          label={snapshot.controlApi.liveness.ok ? "Alive" : "Unavailable"}
          tone={snapshot.controlApi.liveness.ok ? "positive" : "critical"}
        />
      </Surface>
      <Surface className="health-row" level="raised">
        <div>
          <h2>PostgreSQL readiness</h2>
          <p>Mandatory database dependency reported by control-api.</p>
        </div>
        <Badge
          label={postgres === "ready" ? "Ready" : "Unavailable"}
          tone={postgres === "ready" ? "positive" : "critical"}
        />
      </Surface>
      <Button onClick={() => void refresh()} variant="secondary">
        Refresh status
      </Button>
    </div>
  );
}
