"use client";

import {
  Button,
  AnimatedNumber,
  Checkbox,
  DataTable,
  ErrorState,
  LoadingSkeleton,
  StatusIndicator,
} from "@or-on/ui";
import {
  Activity,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Clock3,
  Database,
  Gauge,
  MessageCircle,
  PhoneCall,
  RefreshCw,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

interface HealthSnapshot {
  readonly checkedAt: string;
  readonly controlApi: {
    readonly liveness: {
      readonly ok: boolean;
      readonly status: number;
      readonly durationMs: number;
    };
    readonly readiness: {
      readonly data: { readonly dependencies: { readonly postgres: string } };
      readonly ok: boolean;
      readonly status: number;
      readonly durationMs: number;
    };
  } | null;
  readonly runtimeGates: {
    readonly whatsappDelivery: boolean;
    readonly whatsappAi: boolean;
    readonly voiceCalling: boolean;
    readonly automaticCallbacks: boolean;
  };
}
type HealthState = "operational" | "partial" | "major" | "degraded" | "unknown";
interface Observation {
  readonly at: string;
  readonly state: HealthState;
  readonly duration: number;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function httpStatus(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  );
}
function duration(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function isHealthSnapshot(value: unknown): value is HealthSnapshot {
  if (
    !isRecord(value) ||
    typeof value.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(value.checkedAt))
  )
    return false;
  if (!isRecord(value.runtimeGates)) return false;
  const gates = value.runtimeGates;
  if (
    typeof gates.whatsappDelivery !== "boolean" ||
    typeof gates.whatsappAi !== "boolean" ||
    typeof gates.voiceCalling !== "boolean" ||
    typeof gates.automaticCallbacks !== "boolean"
  )
    return false;
  if (value.controlApi === null) return true;
  const api = value.controlApi;
  if (!isRecord(api) || !isRecord(api.liveness) || !isRecord(api.readiness))
    return false;
  const readiness = api.readiness;
  return (
    typeof api.liveness.ok === "boolean" &&
    httpStatus(api.liveness.status) &&
    duration(api.liveness.durationMs) &&
    typeof readiness.ok === "boolean" &&
    httpStatus(readiness.status) &&
    duration(readiness.durationMs) &&
    isRecord(readiness.data) &&
    isRecord(readiness.data.dependencies) &&
    (readiness.data.dependencies.postgres === "ready" ||
      readiness.data.dependencies.postgres === "unavailable")
  );
}
function stateOf(snapshot: HealthSnapshot): HealthState {
  if (!snapshot.controlApi) return "unknown";
  const live = snapshot.controlApi.liveness.ok;
  const ready =
    snapshot.controlApi.readiness.ok &&
    snapshot.controlApi.readiness.data.dependencies.postgres === "ready";
  return live && ready
    ? "operational"
    : !live && !ready
      ? "major"
      : live && !ready
        ? "partial"
        : "degraded";
}

export function HealthPanel() {
  const t = useTranslations();
  const copy = useTranslations("tenantHealth");
  const locale = useLocale();
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<"malformed" | "unreachable" | null>(
    null,
  );
  const [automatic, setAutomatic] = useState(true);
  const [history, setHistory] = useState<readonly Observation[]>([]);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (active.current) return;
    const controller = new AbortController();
    const deadlineState = { expired: false };
    const deadline = window.setTimeout(() => {
      deadlineState.expired = true;
      controller.abort();
    }, 10000);
    active.current = controller;
    setLoading(true);
    const started = performance.now();
    let state: HealthState = "unknown";
    try {
      const response = await fetch("/api/system/health", {
        cache: "no-store",
        signal: controller.signal,
      });
      const data: unknown = await response.json();
      if (!mounted.current || controller.signal.aborted) return;
      if (!isHealthSnapshot(data)) {
        setFailure("malformed");
        return;
      }
      if (data.controlApi === null) {
        setFailure("unreachable");
        return;
      }
      setSnapshot(data);
      setFailure(null);
      state = stateOf(data);
    } catch (caught) {
      if (
        (!controller.signal.aborted || deadlineState.expired) &&
        mounted.current
      )
        setFailure(caught instanceof SyntaxError ? "malformed" : "unreachable");
    } finally {
      window.clearTimeout(deadline);
      if (active.current === controller) active.current = null;
      if (
        mounted.current &&
        (!controller.signal.aborted || deadlineState.expired)
      ) {
        setLoading(false);
        setHistory((previous) => [
          ...previous.slice(-11),
          {
            at: new Date().toISOString(),
            state,
            duration: Math.round(performance.now() - started),
          },
        ]);
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      active.current?.abort();
      active.current = null;
    };
  }, [refresh]);
  useEffect(() => {
    if (!automatic) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [automatic, refresh]);

  if (loading && snapshot === null && history.length === 0)
    return (
      <div className="health-skeleton" aria-label={t("health.checking")}>
        <LoadingSkeleton label={t("health.checking")} />
        <LoadingSkeleton label={t("health.checking")} />
      </div>
    );
  if (snapshot === null)
    return (
      <ErrorState
        action={
          <Button busy={loading} onClick={() => void refresh()}>
            {t("health.again")}
          </Button>
        }
        description={
          failure === "malformed"
            ? t("premiumVoice.healthMalformed")
            : t("health.hint")
        }
        title={t("health.unavailable")}
      />
    );

  const api = snapshot.controlApi;
  if (!api) return null;
  const state = failure ? "unknown" : stateOf(snapshot);
  const tone =
    state === "operational"
      ? "positive"
      : state === "unknown"
        ? "neutral"
        : "critical";
  const last = history.at(-1);
  const observedDurations = history.map((item) => item.duration);
  const averageDuration = observedDurations.length
    ? Math.round(
        observedDurations.reduce((total, value) => total + value, 0) /
          observedDurations.length,
      )
    : 0;
  const slowestDuration = observedDurations.length
    ? Math.max(...observedDurations)
    : 0;
  const successfulObservations = history.filter(
    (item) => item.state === "operational",
  ).length;
  const sessionReliability = history.length
    ? Math.round((successfulObservations / history.length) * 100)
    : 0;
  const maxHistoryDuration = Math.max(1, ...observedDurations);
  const probeDuration = Math.max(
    api.liveness.durationMs,
    api.readiness.durationMs,
  );
  const checks = [
    {
      key: "api",
      icon: Server,
      title: "health.process",
      hint: "tenantHealth.apiHint",
      ok: api.liveness.ok,
      observation: t("health.httpStatus", { status: api.liveness.status }),
      duration: api.liveness.durationMs,
    },
    {
      key: "readiness",
      icon: ShieldCheck,
      title: "premiumVoice.serviceReadiness",
      hint: "tenantHealth.readinessHint",
      ok: api.readiness.ok,
      observation: t("health.httpStatus", { status: api.readiness.status }),
      duration: api.readiness.durationMs,
    },
    {
      key: "database",
      icon: Database,
      title: "health.database",
      hint: "tenantHealth.databaseHint",
      ok: api.readiness.data.dependencies.postgres === "ready",
      observation: t("health.databaseHint"),
      duration: api.readiness.durationMs,
    },
  ];
  const gates = [
    {
      key: "whatsappDelivery",
      icon: MessageCircle,
      label: copy("whatsappDelivery"),
      enabled: snapshot.runtimeGates.whatsappDelivery,
    },
    {
      key: "whatsappAi",
      icon: Bot,
      label: copy("whatsappAi"),
      enabled: snapshot.runtimeGates.whatsappAi,
    },
    {
      key: "voiceCalling",
      icon: PhoneCall,
      label: copy("voiceCalling"),
      enabled: snapshot.runtimeGates.voiceCalling,
    },
    {
      key: "automaticCallbacks",
      icon: Activity,
      label: copy("automaticCallbacks"),
      enabled: snapshot.runtimeGates.automaticCallbacks,
    },
  ];
  return (
    <div className="health-console">
      <section
        className="health-overview"
        aria-labelledby="health-overall"
        data-state={state}
      >
        <span
          className="health-live-signal"
          data-state={state}
          aria-hidden="true"
        >
          <Activity size={24} />
        </span>
        <div>
          <p className="eyebrow">{copy("observedScope")}</p>
          <h2 id="health-overall" aria-live="polite">
            {copy(state)}
          </h2>
          <p>{copy("scope")}</p>
        </div>
        <StatusIndicator label={copy(state)} tone={tone} />
      </section>
      <section
        className="health-metric-grid"
        aria-label={copy("sessionMetrics")}
      >
        <article>
          <span className="health-metric-icon" data-tone="positive">
            <CheckCircle2 aria-hidden="true" size={17} />
          </span>
          <div>
            <span>{copy("passingChecks")}</span>
            <strong>
              <AnimatedNumber
                animateOnMount
                locale={locale}
                value={checks.filter((check) => check.ok).length}
              />
              <small> / {checks.length}</small>
            </strong>
          </div>
        </article>
        <article>
          <span className="health-metric-icon">
            <Clock3 aria-hidden="true" size={17} />
          </span>
          <div>
            <span>{copy("browserRoundTrip")}</span>
            <strong>
              <AnimatedNumber locale={locale} value={last?.duration ?? 0} />
              <small> ms</small>
            </strong>
          </div>
        </article>
        <article>
          <span className="health-metric-icon">
            <Gauge aria-hidden="true" size={17} />
          </span>
          <div>
            <span>{copy("serviceProbe")}</span>
            <strong>
              <AnimatedNumber locale={locale} value={probeDuration} />
              <small> ms</small>
            </strong>
          </div>
        </article>
        <article>
          <span className="health-metric-icon" data-tone="positive">
            <Activity aria-hidden="true" size={17} />
          </span>
          <div>
            <span>{copy("sessionReliability")}</span>
            <strong>
              <AnimatedNumber locale={locale} value={sessionReliability} />
              <small>%</small>
            </strong>
          </div>
        </article>
      </section>
      <div className="health-toolbar">
        <div>
          <strong>
            {failure
              ? copy("unknown")
              : copy("checks", {
                  ready: checks.filter((check) => check.ok).length,
                  total: checks.length,
                })}
          </strong>
          <span>
            {t("health.checked", {
              time: new Date(snapshot.checkedAt).toLocaleString(locale),
            })}
          </span>
        </div>
        <Checkbox
          checked={automatic}
          onChange={(event) => setAutomatic(event.target.checked)}
        >
          {copy("automatic")}
        </Checkbox>
        <Button
          busy={loading}
          onClick={() => void refresh()}
          size="small"
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" size={14} />
          {t("health.refresh")}
        </Button>
      </div>
      {failure ? (
        <p className="health-stale" role="alert">
          {copy("stale")}
        </p>
      ) : null}
      <section className="health-services" aria-label={t("health.services")}>
        <DataTable label={t("health.services")} minWidth="0">
          <thead>
            <tr>
              <th scope="col">{t("premiumVoice.healthCheck")}</th>
              <th scope="col">{t("premiumVoice.healthObservation")}</th>
              <th scope="col">{t("inbox.status")}</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((check) => (
              <tr key={check.key}>
                <th scope="row">
                  <span className="health-check-name">
                    <check.icon aria-hidden="true" size={18} />
                    {t(check.title)}
                  </span>
                  <small>{t(check.hint)}</small>
                </th>
                <td>
                  <span className="health-observation-value">
                    {check.observation}
                    <small>
                      {copy("probeTime", { value: check.duration })}
                    </small>
                  </span>
                </td>
                <td>
                  <StatusIndicator
                    label={
                      failure
                        ? copy("staleLabel")
                        : check.ok
                          ? t("health.ready")
                          : t("health.notReady")
                    }
                    tone={
                      failure ? "neutral" : check.ok ? "positive" : "critical"
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </section>
      <div className="health-details-grid">
        <section
          className="health-observation-history"
          aria-labelledby="health-history"
        >
          <header>
            <h2 id="health-history">{copy("history")}</h2>
            <span>{copy("samples", { count: history.length })}</span>
          </header>
          <p>{copy("historyScope")}</p>
          <div
            className="health-history-bars"
            role="list"
            aria-label={copy("history")}
          >
            {history.map((item, index) => (
              <div
                role="listitem"
                key={item.at + String(index)}
                data-state={item.state}
                title={
                  new Date(item.at).toLocaleTimeString(locale) +
                  " · " +
                  copy(item.state) +
                  " · " +
                  copy("duration", { value: item.duration })
                }
                style={
                  {
                    "--health-bar-height":
                      String(
                        Math.max(
                          18,
                          Math.round(
                            (item.duration / maxHistoryDuration) * 100,
                          ),
                        ),
                      ) + "%",
                    "--health-bar-index": String(index),
                  } as CSSProperties
                }
              >
                <span className="sr-only">
                  {new Date(item.at).toLocaleTimeString(locale)} ·{" "}
                  {copy(item.state)}
                </span>
              </div>
            ))}
          </div>
          <div className="health-history-axis">
            <span>
              {history[0]
                ? new Date(history[0].at).toLocaleTimeString(locale)
                : "—"}
            </span>
            <span>{copy("latest")}</span>
          </div>
          <details>
            <summary>{copy("observationLog")}</summary>
            <ul>
              {history.toReversed().map((item, index) => (
                <li key={item.at + String(index)}>
                  <time dateTime={item.at}>
                    {new Date(item.at).toLocaleTimeString(locale)}
                  </time>
                  <span>{copy(item.state)}</span>
                  <span>{copy("duration", { value: item.duration })}</span>
                </li>
              ))}
            </ul>
          </details>
        </section>
        <section
          className="health-runtime-gates"
          aria-labelledby="health-gates-title"
        >
          <header>
            <div>
              <p className="eyebrow">{copy("configuration")}</p>
              <h2 id="health-gates-title">{copy("runtimeGates")}</h2>
            </div>
            <span>
              {gates.filter((gate) => gate.enabled).length} / {gates.length}
            </span>
          </header>
          <p>{copy("runtimeGatesScope")}</p>
          <ul>
            {gates.map((gate) => (
              <li key={gate.key} data-enabled={gate.enabled}>
                <span>
                  <gate.icon aria-hidden="true" size={17} />
                </span>
                <div>
                  <strong>{gate.label}</strong>
                  <small>
                    {copy(gate.enabled ? "configured" : "disabled")}
                  </small>
                </div>
                <i aria-hidden="true" />
              </li>
            ))}
          </ul>
        </section>
        <section
          className="health-coverage"
          aria-labelledby="health-coverage-title"
        >
          <h2 id="health-coverage-title">{copy("coverage")}</h2>
          <dl>
            <div>
              <dt>{copy("roundTrip")}</dt>
              <dd>{last ? copy("duration", { value: last.duration }) : "—"}</dd>
            </div>
            <div>
              <dt>{copy("averageRoundTrip")}</dt>
              <dd>
                {history.length
                  ? copy("duration", { value: averageDuration })
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>{copy("slowestRoundTrip")}</dt>
              <dd>
                {history.length
                  ? copy("duration", { value: slowestDuration })
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>{copy("successfulObservations")}</dt>
              <dd>
                {successfulObservations} / {history.length}
              </dd>
            </div>
            <div>
              <dt>{copy("frequency")}</dt>
              <dd>{copy(automatic ? "everyThirty" : "manual")}</dd>
            </div>
          </dl>
          <p>{copy("roundTripScope")}</p>
          <p>{t("health.omitted")}</p>
          <nav aria-label={copy("workspaces")}>
            <Link href="/operations">
              {t("shell.campaigns")}
              <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
            <Link href="/voice">
              {t("shell.voice")}
              <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
            <Link href="/orchestration">
              {t("shell.agents")}
              <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          </nav>
        </section>
      </div>
    </div>
  );
}
