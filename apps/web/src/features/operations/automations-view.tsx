"use client";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { GitBranch } from "lucide-react";
import Link from "next/link";
import type { AutomationRunSummary, AutomationSummary } from "@or-on/crm";
import { Badge, Button, EmptyState, Input, Select } from "@or-on/ui";
import { crmMutation } from "../crm";
import { AutomationRunHistory } from "./run-history";

export function AutomationsView({
  automations,
  runs,
  activeTab,
  pending,
  canManageFlows,
  simulationAvailable,
  run,
  openCreation,
}: {
  readonly automations: readonly AutomationSummary[];
  readonly runs: readonly AutomationRunSummary[];
  readonly activeTab: "campaigns" | "automations" | "history";
  readonly pending: boolean;
  readonly canManageFlows: boolean;
  readonly simulationAvailable: boolean;
  readonly run: (operation: () => Promise<unknown>) => Promise<boolean>;
  readonly openCreation: (kind: "campaigns" | "automations") => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const number = new Intl.NumberFormat(locale);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState<string>();
  const visible = automations.filter(
    (item) =>
      (status === "all" ||
        (item.published ? "published" : "draft") === status) &&
      `${item.name} ${item.description ?? ""}`
        .toLocaleLowerCase(locale)
        .includes(query.trim().toLocaleLowerCase(locale)),
  );
  const published = automations.filter((item) => item.published).length;
  const successful = runs.filter((item) => item.status === "succeeded").length;
  const failedRuns = runs.filter((item) => item.status === "failed").length;

  return (
    <section
      aria-labelledby="operations-automations-tab"
      id="operations-automations-panel"
      className="operation-workspace__panel"
      hidden={activeTab !== "automations"}
      role="tabpanel"
    >
      {automations.length ? (
        <div className="tenant-campaign-outcomes">
          <dl>
            <div>
              <dt>{t("status.published")}</dt>
              <dd>{number.format(published)}</dd>
            </div>
            <div>
              <dt>{t("premiumPrimary.successfulRuns")}</dt>
              <dd>{number.format(successful)}</dd>
            </div>
            <div>
              <dt>{t("premiumPrimary.failedRuns")}</dt>
              <dd>{number.format(failedRuns)}</dd>
            </div>
          </dl>
          <p>{t("tenantOperations.runSample")}</p>
        </div>
      ) : null}
      <section
        className="operation-index"
        aria-labelledby="automation-index-title"
      >
        <header className="operation-index__header">
          <div>
            <h2 id="automation-index-title">
              {t("premiumPrimary.automationIndex")}
            </h2>
            <p className="feature-copy">
              {t("premiumPrimary.automationIndexHint")}
            </p>
          </div>
          <span className="operation-count">
            {number.format(automations.length)}
          </span>
        </header>
        {automations.length ? (
          <div className="tenant-register-toolbar">
            <Input
              id="automation-search"
              type="search"
              label={t("tenantOperations.search")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Select
              id="automation-status"
              label={t("inbox.status")}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="all">{t("tenantOperations.allStates")}</option>
              <option value="published">{t("status.published")}</option>
              <option value="draft">{t("status.draft")}</option>
            </Select>
            <p role="status">
              {t("tenantOperations.showing", {
                count: visible.length,
                total: automations.length,
              })}
            </p>
          </div>
        ) : null}
        {automations.length === 0 ? (
          <EmptyState
            title={t("operations.emptyAutomationsTitle")}
            description={t(
              canManageFlows
                ? "operations.emptyAutomationsDescription"
                : "operations.emptyReadOnly",
            )}
            action={
              canManageFlows ? (
                <Button
                  onClick={() => openCreation("automations")}
                  variant="secondary"
                >
                  {t("operations.startAutomation")}
                </Button>
              ) : undefined
            }
          />
        ) : visible.length === 0 ? (
          <p className="tenant-no-results">{t("tenantOperations.noMatches")}</p>
        ) : (
          <div className="operation-index__rows">
            {visible.map((automation) => {
              const recent = runs.find(
                (item) => item.definitionId === automation.id,
              );
              return (
                <article
                  className="operation-index__row automation-index-row"
                  key={automation.id}
                >
                  <span
                    className="automation-index-row__icon"
                    aria-hidden="true"
                  >
                    <GitBranch size={18} />
                  </span>
                  <div className="operation-index__identity">
                    <strong>
                      <bdi>{automation.name}</bdi>
                    </strong>
                    <p>
                      {automation.description ??
                        t("premiumPrimary.noDescription")}
                    </p>
                    <span>
                      {t("operations.version", {
                        version: automation.version,
                        status: t(`status.${automation.validationStatus}`),
                      })}
                    </span>
                  </div>
                  <div className="automation-index-row__state">
                    <Badge
                      label={t(
                        automation.published
                          ? "status.published"
                          : "status.draft",
                      )}
                      tone={automation.published ? "positive" : "neutral"}
                    />
                    {recent?.startedAt ? (
                      <time dateTime={recent.startedAt}>
                        {date.format(new Date(recent.startedAt))}
                      </time>
                    ) : (
                      <small>{t("premiumPrimary.notRun")}</small>
                    )}
                  </div>
                  <Button
                    variant="quiet"
                    size="small"
                    aria-pressed={selectedId === automation.id}
                    onClick={() =>
                      setSelectedId(
                        selectedId === automation.id
                          ? undefined
                          : automation.id,
                      )
                    }
                  >
                    {t("tenantOperations.runHistory")}
                  </Button>
                  {automation.executionKind !== "empty" ? (
                    <Link className="text-link" href="/orchestration?tab=flows">
                      {t("premiumPrimary.openFlowStudio")}
                    </Link>
                  ) : (
                    <Button
                      busy={pending}
                      disabled={
                        !canManageFlows ||
                        (automation.published && !simulationAvailable)
                      }
                      onClick={() =>
                        void run(() =>
                          crmMutation(
                            `/api/automations/${automation.id}/${automation.published ? "run" : "publish"}`,
                            {},
                          ),
                        )
                      }
                      size="small"
                      variant="secondary"
                    >
                      {t(
                        automation.published
                          ? "operations.run"
                          : "operations.publish",
                      )}
                    </Button>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
      {selectedId ? (
        <AutomationRunHistory
          key={selectedId}
          definitionId={selectedId}
          runs={runs}
          flows={automations}
        />
      ) : null}
    </section>
  );
}
