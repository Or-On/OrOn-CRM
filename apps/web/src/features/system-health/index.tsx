"use client";

import { useTranslations, useLocale } from "next-intl";

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
  const t = useTranslations();
  const locale = useLocale();
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
    return <LoadingSkeleton label={t("health.checking")} />;
  if (snapshot?.controlApi === null) {
    return (
      <ErrorState
        action={
          <Button onClick={() => void refresh()}>{t("health.again")}</Button>
        }
        description={t("health.hint")}
        title={t("health.unavailable")}
      />
    );
  }
  if (snapshot === null) return null;

  const postgres = snapshot.controlApi.readiness.data.dependencies.postgres;
  const ready = snapshot.controlApi.readiness.ok && postgres === "ready";
  return (
    <div aria-live="polite" className="health-stack">
      <Surface className="health-row" level="raised">
        <div>
          <h2>{t("health.process")}</h2>
          <p>
            HTTP {snapshot.controlApi.liveness.status} ·{" "}
            {t("health.checked", {
              time: new Date(snapshot.checkedAt).toLocaleString(locale),
            })}
          </p>
        </div>
        <Badge
          label={
            snapshot.controlApi.liveness.ok
              ? t("health.alive")
              : t("health.unknown")
          }
          tone={snapshot.controlApi.liveness.ok ? "positive" : "critical"}
        />
      </Surface>
      <Surface className="health-row" level="raised">
        <div>
          <h2>{t("health.database")}</h2>
          <p>{t("health.databaseHint")}</p>
        </div>
        <Badge
          label={ready ? t("health.ready") : t("health.notReady")}
          tone={ready ? "positive" : "critical"}
        />
      </Surface>
      <Button onClick={() => void refresh()} variant="secondary">
        {t("health.refresh")}
      </Button>
    </div>
  );
}
