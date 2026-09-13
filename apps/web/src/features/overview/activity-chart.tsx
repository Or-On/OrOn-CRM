"use client";

import type { OverviewInsights } from "@or-on/crm";
import { AnimatedNumber, MotionProvider } from "@or-on/ui";
import { m, useReducedMotion } from "motion/react";
import { useLocale, useTranslations } from "next-intl";
import { useState, type CSSProperties } from "react";

const CHART_WIDTH = 1000;
const CHART_HEIGHT = 240;
const CHART_TOP = 12;
const CHART_BOTTOM = 202;
const CHART_LEFT = 12;
const CHART_RIGHT = 988;

/** Animated operational chart built from recorded UTC-day aggregates. */
function MessageActivityChartContent({
  days,
}: {
  readonly days: OverviewInsights["dailyMessages"];
}) {
  const t = useTranslations("premiumOverview");
  const copy = useTranslations("tenantOverview");
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const [selected, setSelected] = useState<number>();
  const [outcomes, setOutcomes] = useState(false);
  const values = days.map((day) => ({
    ...day,
    total: outcomes
      ? (day.delivered ?? 0) + (day.failed ?? 0)
      : day.inbound + day.outbound,
  }));
  const max = Math.max(1, ...values.map((day) => day.total));
  const total = values.reduce((count, day) => count + day.total, 0);
  const date = (day: string) =>
    new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${day}T12:00:00Z`));
  const active = selected === undefined ? undefined : days[selected];
  const summary = (day: OverviewInsights["dailyMessages"][number]) =>
    outcomes
      ? copy("outcomeDay", {
          day: date(day.day),
          delivered: day.delivered ?? 0,
          failed: day.failed ?? 0,
        })
      : t("daySummary", {
          day: date(day.day),
          inbound: day.inbound,
          outbound: day.outbound,
        });
  const availableHeight = CHART_BOTTOM - CHART_TOP;
  const plotWidth = CHART_RIGHT - CHART_LEFT;
  const slotWidth = plotWidth / Math.max(1, values.length);
  const pointX = (index: number) =>
    values.length <= 1
      ? CHART_LEFT + plotWidth / 2
      : CHART_LEFT + (index / (values.length - 1)) * plotWidth;
  const pointY = (value: number) =>
    CHART_BOTTOM - (value / max) * availableHeight;
  const linePath = values
    .map((day, index) => {
      const command = index === 0 ? "M" : "L";
      return `${command} ${String(pointX(index))} ${String(pointY(day.total))}`;
    })
    .join(" ");
  const trend = (() => {
    if (values.length === 0) return undefined;
    if (values.length === 1) {
      const y = pointY(values[0]?.total ?? 0);
      return { startY: y, endY: y };
    }
    const count = values.length;
    const meanX = (count - 1) / 2;
    const meanY = total / count;
    const numerator = values.reduce(
      (sum, day, index) => sum + (index - meanX) * (day.total - meanY),
      0,
    );
    const denominator = values.reduce(
      (sum, _, index) => sum + (index - meanX) ** 2,
      0,
    );
    const slope = denominator === 0 ? 0 : numerator / denominator;
    const clampValue = (value: number) => Math.max(0, Math.min(max, value));
    return {
      startY: pointY(clampValue(meanY - slope * meanX)),
      endY: pointY(clampValue(meanY + slope * meanX)),
    };
  })();

  return (
    <section
      className="overview-activity-chart"
      aria-labelledby="message-chart-title"
    >
      <header className="overview-chart-header">
        <div>
          <h2 id="message-chart-title">{copy("chartTitle")}</h2>
          <p>{outcomes ? copy("outcomeScope") : t("utcScope")}</p>
        </div>
        <fieldset className="overview-chart-switch">
          <legend className="sr-only">{copy("chartTitle")}</legend>
          <label>
            <input
              type="radio"
              name="chart-view"
              checked={!outcomes}
              onChange={() => {
                setOutcomes(false);
                setSelected(undefined);
              }}
            />
            <span>{copy("volumeView")}</span>
          </label>
          <label>
            <input
              type="radio"
              name="chart-view"
              checked={outcomes}
              onChange={() => {
                setOutcomes(true);
                setSelected(undefined);
              }}
            />
            <span>{copy("outcomesView")}</span>
          </label>
        </fieldset>
      </header>

      <div className="overview-chart-overline">
        <div className="overview-chart-summary">
          <strong>
            <AnimatedNumber animateOnMount locale={locale} value={total} />
          </strong>
          <span>{outcomes ? copy("outcomeTotal") : t("recordedMessages")}</span>
        </div>
        <div className="overview-chart-legend" aria-hidden="true">
          <span>
            <i className="series" />
            {outcomes ? copy("outcomesView") : copy("volumeView")}
          </span>
          <span>
            <i className="trend" />
            {copy("trendLabel")}
          </span>
          <span className="overview-period">{t("fourteenDays")}</span>
        </div>
      </div>

      <div className="overview-chart-stage" dir="ltr">
        <svg
          aria-hidden="true"
          className="overview-chart-svg"
          preserveAspectRatio="none"
          viewBox={`0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}`}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((step) => {
            const y = CHART_TOP + (CHART_BOTTOM - CHART_TOP) * step;
            return (
              <line
                className="overview-chart-gridline"
                key={step}
                x1={CHART_LEFT}
                x2={CHART_RIGHT}
                y1={y}
                y2={y}
              />
            );
          })}
          <g key={outcomes ? "outcomes" : "volume"}>
            {selected !== undefined ? (
              <rect
                className="overview-chart-column-highlight"
                height={availableHeight}
                width={slotWidth}
                x={CHART_LEFT + selected * slotWidth}
                y={CHART_TOP}
              />
            ) : null}
            {trend ? (
              <m.line
                animate={{ opacity: 1, pathLength: 1 }}
                className="overview-chart-trend"
                initial={reduceMotion ? false : { opacity: 0, pathLength: 0 }}
                transition={{
                  delay: reduceMotion ? 0 : 0.2,
                  duration: reduceMotion ? 0 : 0.8,
                  ease: "easeOut",
                }}
                x1={CHART_LEFT}
                x2={CHART_RIGHT}
                y1={trend.startY}
                y2={trend.endY}
              />
            ) : null}
            {linePath ? (
              <m.path
                animate={{ opacity: 1, y: 0 }}
                className="overview-chart-line overview-chart-line--angular overview-chart-line--animated"
                d={linePath}
                initial={reduceMotion ? false : { opacity: 0.35, y: 8 }}
                transition={{
                  duration: reduceMotion ? 0 : 0.45,
                  ease: "easeOut",
                }}
              />
            ) : null}
          </g>
        </svg>

        {active && selected !== undefined ? (
          <div
            className="overview-chart-tooltip"
            style={
              {
                "--tooltip-position": `${String(
                  values.length <= 1
                    ? 50
                    : (selected / (values.length - 1)) * 100,
                )}%`,
              } as CSSProperties
            }
          >
            <strong>{date(active.day)}</strong>
            <span>{summary(active)}</span>
          </div>
        ) : null}

        {values.length > 0 ? (
          <div
            className="overview-chart-hit-targets"
            role="group"
            aria-label={t("inspectDay")}
            style={
              {
                "--chart-days": values.length,
              } as CSSProperties
            }
          >
            {values.map((day, index) => (
              <button
                aria-label={summary(day)}
                aria-pressed={selected === index}
                key={day.day}
                type="button"
                onBlur={() => setSelected(undefined)}
                onClick={() => setSelected(index)}
                onFocus={() => setSelected(index)}
                onMouseEnter={() => setSelected(index)}
                onMouseLeave={() => setSelected(undefined)}
              >
                <span className="overview-bar-day" aria-hidden="true">
                  {index === 0 ||
                  index === days.length - 1 ||
                  (index % 4 === 0 && index < days.length - 2)
                    ? date(day.day)
                    : ""}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <p className="overview-chart-inspection" aria-live="polite">
        {active
          ? summary(active)
          : t(total === 0 ? "noRecordedActivity" : "inspectHint")}
      </p>
      <details className="overview-chart-data">
        <summary>{t("viewData")}</summary>
        <table>
          <caption>{t("utcScope")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("day")}</th>
              <th scope="col">{t("inbound")}</th>
              <th scope="col">{t("outbound")}</th>
              <th scope="col">{copy("delivered")}</th>
              <th scope="col">{copy("failed")}</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.day}>
                <th scope="row">{date(day.day)}</th>
                <td>{day.inbound.toLocaleString(locale)}</td>
                <td>{day.outbound.toLocaleString(locale)}</td>
                <td>{(day.delivered ?? 0).toLocaleString(locale)}</td>
                <td>{(day.failed ?? 0).toLocaleString(locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

export function MessageActivityChart({
  days,
}: {
  readonly days: OverviewInsights["dailyMessages"];
}) {
  return (
    <MotionProvider>
      <MessageActivityChartContent days={days} />
    </MotionProvider>
  );
}
