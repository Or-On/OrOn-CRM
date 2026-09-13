"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AutomationRunSummary, AutomationSummary } from "@or-on/crm";
import { Badge, DataTable, Select } from "@or-on/ui";

export function AutomationRunHistory({
  runs,
  flows,
  definitionId,
}: {
  readonly runs: readonly AutomationRunSummary[];
  readonly flows: readonly AutomationSummary[];
  readonly definitionId?: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [status, setStatus] = useState("all");
  const scoped = definitionId
    ? runs.filter((run) => run.definitionId === definitionId)
    : runs;
  const visible = scoped.filter(
    (run) => status === "all" || run.status === status,
  );
  const statuses = [...new Set(scoped.map((run) => run.status))];
  const statusLabel = (value: string) =>
    value === "handed_off"
      ? t("tenantOperations.handedOff")
      : t.has(`status.${value}`)
        ? t(`status.${value}`)
        : value;
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <section
      className="tenant-run-history"
      aria-label={t("tenantOperations.runHistory")}
    >
      <header className="tenant-register-heading">
        <div>
          <h3>{t("tenantOperations.runHistory")}</h3>
          <p>{t("tenantOperations.runSample")}</p>
        </div>
        <Select
          id={`run-status-${definitionId ?? "all"}`}
          label={t("inbox.status")}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="all">{t("tenantOperations.allStates")}</option>
          {statuses.map((value) => (
            <option key={value} value={value}>
              {statusLabel(value)}
            </option>
          ))}
        </Select>
      </header>
      <p className="tenant-result-count" role="status">
        {t("tenantOperations.showing", {
          count: visible.length,
          total: scoped.length,
        })}
      </p>
      {visible.length === 0 ? (
        <p className="tenant-no-results">{t("tenantOperations.noRuns")}</p>
      ) : (
        <DataTable label={t("tenantOperations.runHistory")} minWidth="36rem">
          <thead>
            <tr>
              <th scope="col">{t("operations.name")}</th>
              <th scope="col">{t("inbox.status")}</th>
              <th scope="col">{t("voice.time")}</th>
              <th scope="col">{t("voice.duration")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((run) => {
              const duration =
                run.startedAt && run.completedAt
                  ? Math.max(
                      0,
                      (Date.parse(run.completedAt) -
                        Date.parse(run.startedAt)) /
                        1000,
                    )
                  : null;
              return (
                <tr key={run.id}>
                  <th scope="row">
                    <strong>
                      {flows.find((flow) => flow.id === run.definitionId)
                        ?.name ?? t("operations.manual")}
                    </strong>
                    <small>
                      <code dir="ltr">{run.id.slice(0, 8)}</code>
                    </small>
                  </th>
                  <td>
                    <Badge
                      label={statusLabel(run.status)}
                      tone={
                        run.status === "succeeded"
                          ? "positive"
                          : run.status === "failed"
                            ? "critical"
                            : "neutral"
                      }
                    />
                  </td>
                  <td>
                    {run.startedAt ? (
                      <time dateTime={run.startedAt}>
                        {date.format(new Date(run.startedAt))}
                      </time>
                    ) : (
                      t("common.notSet")
                    )}
                  </td>
                  <td>
                    {duration === null
                      ? t("common.notSet")
                      : t("voice.seconds", {
                          count: Math.round(duration * 10) / 10,
                        })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </section>
  );
}
