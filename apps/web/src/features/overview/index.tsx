import type {
  DashboardMetrics,
  OverviewMetrics,
  OverviewInsights,
  TenantOperationalInsights,
} from "@or-on/crm";
import { AnimatedNumber, DataTable, StatusIndicator } from "@or-on/ui";
import {
  ArrowUpRight,
  CheckCheck,
  CircleCheckBig,
  Clock3,
  ContactRound,
  MessagesSquare,
  Send,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { MessageActivityChart } from "./activity-chart";
export { MessageActivityChart } from "./activity-chart";

function formatExactCurrency(
  value: string,
  currency: string,
  locale: string,
): string {
  const formatter = new Intl.NumberFormat(locale, {
    currency,
    maximumFractionDigits: 2,
    style: "currency",
  });
  const result: unknown = Reflect.apply(
    formatter.format.bind(formatter),
    undefined,
    [value],
  );
  return typeof result === "string" ? result : value + " " + currency;
}

export function Overview({
  dashboard,
  tenantName,
  metrics,
  insights,
  operations,
}: {
  readonly dashboard: DashboardMetrics;
  readonly tenantName: string;
  readonly metrics: OverviewMetrics;
  readonly insights: OverviewInsights;
  readonly operations: TenantOperationalInsights;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const number = (value: number) => value.toLocaleString(locale);
  const resolved = operations.delivered + operations.failed;
  const rateValue = resolved > 0 ? operations.delivered / resolved : null;
  const rate =
    rateValue !== null
      ? new Intl.NumberFormat(locale, {
          style: "percent",
          maximumFractionDigits: 1,
        }).format(rateValue)
      : "—";
  const ratePercent = (rateValue ?? 0) * 100;
  const today = insights.dailyMessages.at(-1);
  const warnings = [
    {
      count: dashboard.unreadMessages,
      title: "overview.unreadMessages",
      hint: "tenantOverview.unreadHint",
      href: "/inbox?filter=unread",
    },
    {
      count: metrics.pendingHandoffs,
      title: "overview.handoffs",
      hint: "tenantOverview.handoffHint",
      href: "/orchestration?tab=handoffs",
    },
    {
      count: operations.failed,
      title: "tenantOverview.failedMessages",
      hint: "tenantOverview.monthScope",
      href: "/operations",
    },
    {
      count: operations.flowFailed,
      title: "tenantOverview.failedFlows",
      hint: "tenantOverview.monthScope",
      href: "/orchestration?tab=flows",
    },
    {
      count: operations.voiceFailed,
      title: "tenantOverview.failedCalls",
      hint: "tenantOverview.monthScope",
      href: "/voice",
    },
  ].filter((item) => item.count > 0);
  const channels = [
    {
      name: "shell.campaigns",
      href: "/operations",
      total: operations.inbound + operations.outbound,
      unit: "tenantOverview.messages",
      detail: t("tenantOverview.messageDetail", {
        inbound: number(operations.inbound),
        outbound: number(operations.outbound),
      }),
      result: t("tenantOverview.deliveryDetail", {
        count: number(operations.delivered),
      }),
      failures: operations.failed,
    },
    {
      name: "shell.voice",
      href: "/voice",
      total: operations.voiceSessions,
      unit: "tenantOverview.calls",
      detail: t("tenantOverview.voiceDetail", {
        active: number(operations.voiceActive),
      }),
      result: t("tenantOverview.endedCalls", {
        count: number(
          operations.voiceSessions -
            operations.voiceActive -
            operations.voiceFailed,
        ),
      }),
      failures: operations.voiceFailed,
    },
    {
      name: "tenantOverview.agents",
      href: "/orchestration?tab=agents",
      total: operations.agentEvents,
      unit: "tenantOverview.requests",
      detail: t("tenantOverview.agentScope"),
      result: t("tenantOverview.tokens", {
        count: number(operations.agentTokens),
      }),
      failures: null,
    },
    {
      name: "tenantOverview.flows",
      href: "/orchestration?tab=flows",
      total: operations.flowRuns,
      unit: "tenantOverview.runs",
      detail: t("tenantOverview.flowDetail", {
        active: number(operations.flowActive),
      }),
      result: t("tenantOverview.flowSuccess", {
        count: number(operations.flowSucceeded),
      }),
      failures: operations.flowFailed,
    },
  ];
  return (
    <main className="page overview-page">
      <h1 className="or-visually-hidden">{t("tenantOverview.title")}</h1>
      <section
        className="overview-metric-grid"
        aria-label={`${tenantName}: ${t("overview.totals")}`}
      >
        {[
          {
            label: "overview.messagesToday",
            value: today ? today.inbound + today.outbound : 0,
            detail: t("tenantOverview.todayScope"),
            href: "/inbox",
            Icon: Clock3,
          },
          {
            label: "tenantOverview.monthlyMessages",
            value: operations.inbound + operations.outbound,
            detail: t("tenantOverview.monthScope"),
            href: "/operations",
            Icon: Send,
          },
          {
            label: "tenantOverview.deliveryRate",
            value: rate,
            detail: t("tenantOverview.resolvedOutcomes", {
              count: number(resolved),
            }),
            href: "/operations",
            Icon: CircleCheckBig,
          },
          {
            label: "overview.conversations",
            value: dashboard.openConversations,
            detail: t("overview.conversationsHint"),
            href: "/inbox",
            Icon: MessagesSquare,
          },
        ].map((item) => (
          <Link
            key={item.label}
            className="overview-metric-card"
            href={item.href}
          >
            <span className="overview-metric-icon" aria-hidden="true">
              <item.Icon size={16} />
            </span>
            <div className="or-metric">
              <span className="or-metric__label">{t(item.label)}</span>
              <strong className="or-metric__value">
                {typeof item.value === "number" ? (
                  <AnimatedNumber
                    animateOnMount
                    value={item.value}
                    locale={locale}
                  />
                ) : (
                  item.value
                )}
              </strong>
              <span className="or-metric__detail">{item.detail}</span>
            </div>
          </Link>
        ))}
      </section>
      <div className="overview-command-grid">
        <MessageActivityChart days={insights.dailyMessages} />
        <section
          className="overview-reach-card"
          aria-labelledby="overview-reach-title"
        >
          <header className="overview-reach-header">
            <span className="overview-reach-icon" aria-hidden="true">
              <ContactRound size={16} />
            </span>
            <div>
              <h2 id="overview-reach-title">
                {t("tenantOverview.reachTitle")}
              </h2>
              <p>{t("tenantOverview.monthScope")}</p>
            </div>
          </header>
          <div className="overview-reach-primary">
            <strong>
              <AnimatedNumber
                animateOnMount
                locale={locale}
                value={operations.contactsReached}
              />
            </strong>
            <span>{t("tenantOverview.reachContacts")}</span>
            <p>{t("tenantOverview.reachScope")}</p>
          </div>
          <div className="overview-reach-progress" aria-hidden="true">
            <span style={{ inlineSize: `${String(ratePercent)}%` }} />
          </div>
          <div className="overview-reach-facts">
            <div>
              <span>{t("tenantOverview.reachSuccess")}</span>
              <strong>
                {rateValue === null ? (
                  "—"
                ) : (
                  <>
                    <AnimatedNumber
                      animateOnMount
                      locale={locale}
                      maximumFractionDigits={1}
                      value={ratePercent}
                    />
                    %
                  </>
                )}
              </strong>
            </div>
            <div>
              <span>{t("tenantOverview.reachResolved")}</span>
              <strong>
                <AnimatedNumber
                  animateOnMount
                  locale={locale}
                  value={resolved}
                />
              </strong>
            </div>
          </div>
          <Link className="overview-reach-link" href="/contacts">
            {t("tenantOverview.viewContacts")}
            <ArrowUpRight aria-hidden="true" size={14} />
          </Link>
        </section>
        <section
          className="overview-attention"
          aria-labelledby="overview-attention-title"
        >
          <header className="overview-section-heading">
            <h2 id="overview-attention-title">
              {t("premiumOverview.attention")}
            </h2>
            <span className="overview-period">
              {t("tenantOverview.attentionCount", { count: warnings.length })}
            </span>
          </header>
          {warnings.length === 0 ? (
            <div className="overview-all-clear">
              <CheckCheck aria-hidden="true" size={24} />
              <strong>{t("tenantOverview.clear")}</strong>
              <p>{t("tenantOverview.clearHint")}</p>
            </div>
          ) : (
            warnings.map((item) => (
              <Link
                className="overview-attention-item"
                href={item.href}
                key={item.title}
              >
                <span>
                  <strong>{t(item.title)}</strong>
                  <small>{t(item.hint)}</small>
                </span>
                <b>{number(item.count)}</b>
                <ArrowUpRight aria-hidden="true" size={14} />
              </Link>
            ))
          )}
          <p className="overview-scope">{t("tenantOverview.attentionScope")}</p>
        </section>
        <section className="overview-delivery" aria-labelledby="delivery-title">
          <header className="overview-section-heading">
            <h2 id="delivery-title">{t("tenantOverview.deliveryTitle")}</h2>
            <span className="overview-period">
              {t("tenantOverview.monthScope")}
            </span>
          </header>
          <div className="overview-delivery-ledger">
            {[
              { key: "delivered", value: operations.delivered },
              { key: "awaiting", value: operations.awaiting },
              { key: "failed", value: operations.failed },
            ].map((item) => (
              <div key={item.key} data-outcome={item.key}>
                <span>{t("tenantOverview." + item.key)}</span>
                <strong>
                  <AnimatedNumber
                    animateOnMount
                    value={item.value}
                    locale={locale}
                  />
                </strong>
                <meter
                  min={0}
                  max={Math.max(1, operations.outbound)}
                  value={item.value}
                  aria-label={t("tenantOverview." + item.key)}
                />
              </div>
            ))}
          </div>
          <div className="overview-delivery-foot">
            <span>
              {t("tenantOverview.reached", {
                count: number(operations.contactsReached),
              })}
            </span>
            <p>{t("tenantOverview.deliveryScope")}</p>
          </div>
        </section>
        <section
          className="overview-products"
          aria-labelledby="overview-products-title"
        >
          <header className="overview-section-heading">
            <div>
              <h2 id="overview-products-title">
                {t("tenantOverview.productActivity")}
              </h2>
              <p className="overview-scope">
                {t("tenantOverview.cohortScope")}
              </p>
            </div>
            <span className="overview-period">
              {t("tenantOverview.monthScope")}
            </span>
          </header>
          <ul className="overview-products-compact">
            {channels.map((channel) => (
              <li key={channel.name}>
                <header>
                  <Link href={channel.href}>
                    {t(channel.name)}
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </Link>
                  <strong>
                    {number(channel.total)} <small>{t(channel.unit)}</small>
                  </strong>
                </header>
                <p>{channel.detail}</p>
                <div>
                  <span>{channel.result}</span>
                  {channel.failures !== null ? (
                    <span data-failure={channel.failures > 0}>
                      {t("tenantOverview.failures")}: {number(channel.failures)}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          <DataTable
            label={t("tenantOverview.productActivity")}
            minWidth="38rem"
          >
            <thead>
              <tr>
                <th scope="col">{t("tenantOverview.product")}</th>
                <th scope="col">{t("tenantOverview.volume")}</th>
                <th scope="col">{t("tenantOverview.performance")}</th>
                <th scope="col">{t("tenantOverview.failures")}</th>
                <th scope="col">
                  <span className="sr-only">{t("tenantOverview.open")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {channels.map((channel) => (
                <tr key={channel.name}>
                  <th scope="row">
                    <Link href={channel.href}>{t(channel.name)}</Link>
                    <small>{channel.detail}</small>
                  </th>
                  <td>
                    <strong>{number(channel.total)}</strong>{" "}
                    <small>{t(channel.unit)}</small>
                  </td>
                  <td>{channel.result}</td>
                  <td>
                    {channel.failures === null ? (
                      <span title={t("tenantOverview.notReported")}>—</span>
                    ) : (
                      <StatusIndicator
                        label={number(channel.failures)}
                        tone={channel.failures > 0 ? "critical" : "neutral"}
                      />
                    )}
                  </td>
                  <td>
                    <Link
                      href={channel.href}
                      aria-label={
                        t("tenantOverview.open") + " " + t(channel.name)
                      }
                    >
                      <ArrowUpRight size={17} aria-hidden="true" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </section>
      </div>
      <footer className="overview-context-strip">
        <Link href="/contacts">
          {t("tenantOverview.contactCount", {
            count: number(dashboard.contacts),
          })}
        </Link>
        {dashboard.openPipelineValues.length > 0 ? (
          <Link href="/pipelines">
            <span>{t("overview.pipelineValue")}</span>{" "}
            {dashboard.openPipelineValues.map(({ currency, value }) => (
              <bdi key={currency}>
                {formatExactCurrency(value, currency, locale)}
              </bdi>
            ))}
          </Link>
        ) : null}
        <Link href="/system/health">
          {t("overview.diagnostics")}
          <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
      </footer>
    </main>
  );
}
