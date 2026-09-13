"use client";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { BroadcastSummary } from "@or-on/crm";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Progress,
  Input,
  Select,
} from "@or-on/ui";
import { crmMutation } from "../crm";

export function CampaignsView({
  broadcasts,
  activeTab,
  pending,
  canManageCampaigns,
  run,
  openCreation,
}: {
  readonly broadcasts: readonly BroadcastSummary[];
  readonly activeTab: "campaigns" | "automations" | "history";
  readonly pending: boolean;
  readonly canManageCampaigns: boolean;
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
  const visible = broadcasts.filter(
    (item) =>
      (status === "all" || item.status === status) &&
      `${item.name} ${item.id}`
        .toLocaleLowerCase(locale)
        .includes(query.trim().toLocaleLowerCase(locale)),
  );
  const delivered = broadcasts.reduce(
    (total, item) => total + item.deliveredCount,
    0,
  );
  const failed = broadcasts.reduce(
    (total, item) => total + item.failedCount,
    0,
  );
  const recipients = broadcasts.reduce(
    (total, item) => total + item.totalRecipients,
    0,
  );
  const remaining = Math.max(0, recipients - delivered - failed);

  return (
    <section
      aria-labelledby="operations-campaigns-tab"
      id="operations-campaigns-panel"
      className="operation-workspace__panel"
      hidden={activeTab !== "campaigns"}
      role="tabpanel"
    >
      {broadcasts.length ? (
        <div
          className="tenant-campaign-outcomes"
          role="region"
          aria-label={t("premiumPrimary.recipientOutcomes")}
        >
          <dl>
            <div>
              <dt>{t("premiumPrimary.recipients", { count: recipients })}</dt>
              <dd>{number.format(recipients)}</dd>
            </div>
            <div>
              <dt>{t("premiumPrimary.delivered")}</dt>
              <dd>{number.format(delivered)}</dd>
            </div>
            <div>
              <dt>{t("premiumPrimary.failed")}</dt>
              <dd>{number.format(failed)}</dd>
            </div>
            <div>
              <dt>{t("premiumPrimary.remaining")}</dt>
              <dd>{number.format(remaining)}</dd>
            </div>
          </dl>
          <p>{t("tenantOperations.simulationBoundary")}</p>
        </div>
      ) : null}
      <section
        className="operation-index"
        aria-labelledby="campaign-index-title"
      >
        <header className="operation-index__header">
          <div>
            <h2 id="campaign-index-title">
              {t("premiumPrimary.campaignIndex")}
            </h2>
            <p className="feature-copy">
              {t("premiumPrimary.campaignIndexHint")}
            </p>
          </div>
          <span className="operation-count">
            {number.format(broadcasts.length)}
          </span>
        </header>
        {broadcasts.length ? (
          <div className="tenant-register-toolbar">
            <Input
              id="campaign-search"
              type="search"
              label={t("tenantOperations.search")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Select
              id="campaign-status"
              label={t("inbox.status")}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="all">{t("tenantOperations.allStates")}</option>
              {[...new Set(broadcasts.map((item) => item.status))].map(
                (value) => (
                  <option key={value} value={value}>
                    {t(`status.${value}`)}
                  </option>
                ),
              )}
            </Select>
            <p role="status">
              {t("tenantOperations.showing", {
                count: visible.length,
                total: broadcasts.length,
              })}
            </p>
          </div>
        ) : null}
        {broadcasts.length === 0 ? (
          <EmptyState
            title={t("operations.emptyCampaignsTitle")}
            description={t(
              canManageCampaigns
                ? "operations.emptyCampaignsDescription"
                : "operations.emptyReadOnly",
            )}
            action={
              canManageCampaigns ? (
                <Button
                  onClick={() => openCreation("campaigns")}
                  variant="secondary"
                >
                  {t("operations.startCampaign")}
                </Button>
              ) : undefined
            }
          />
        ) : visible.length === 0 ? (
          <p className="tenant-no-results">{t("tenantOperations.noMatches")}</p>
        ) : (
          <DataTable label={t("premiumPrimary.campaignIndex")} minWidth="42rem">
            <thead>
              <tr>
                <th scope="col">{t("operations.campaignName")}</th>
                <th scope="col">{t("inbox.status")}</th>
                <th scope="col">{t("premiumPrimary.deliveryProgress")}</th>
                <th scope="col">{t("premiumPrimary.failed")}</th>
                <th scope="col">{t("common.details")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((broadcast) => (
                <tr key={broadcast.id}>
                  <th scope="row">
                    <strong>
                      <bdi>{broadcast.name}</bdi>
                    </strong>
                    <time dateTime={broadcast.createdAt}>
                      {date.format(new Date(broadcast.createdAt))}
                    </time>
                  </th>
                  <td>
                    <Badge
                      label={t(`status.${broadcast.status}`)}
                      tone={
                        broadcast.status === "sent"
                          ? "positive"
                          : broadcast.status === "failed"
                            ? "critical"
                            : "neutral"
                      }
                    />
                  </td>
                  <td>
                    <div className="operation-delivery">
                      <Progress
                        label={t("operations.delivered", {
                          delivered: broadcast.deliveredCount,
                          total: broadcast.totalRecipients,
                        })}
                        value={broadcast.deliveredCount}
                        max={Math.max(1, broadcast.totalRecipients)}
                      />
                      <span>
                        {t("operations.delivered", {
                          delivered: broadcast.deliveredCount,
                          total: broadcast.totalRecipients,
                        })}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span
                      className={
                        broadcast.failedCount ? "operation-failed" : undefined
                      }
                    >
                      {number.format(broadcast.failedCount)}
                    </span>
                  </td>
                  <td>
                    {broadcast.status === "draft" ? (
                      <Button
                        busy={pending}
                        disabled={!canManageCampaigns}
                        onClick={() =>
                          void run(() =>
                            crmMutation(
                              `/api/campaigns/${broadcast.id}/deliver`,
                              {},
                            ),
                          )
                        }
                        size="small"
                        variant="secondary"
                      >
                        {t("operations.simulate")}
                      </Button>
                    ) : (
                      <span className="operation-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </section>
    </section>
  );
}
