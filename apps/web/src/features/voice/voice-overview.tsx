"use client";

import type {
  FlowSummary,
  PhoneNumberSummary,
  ReconciliationReport,
  VoiceSessionList,
  VoiceSessionSummary,
} from "@or-on/api-client";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Input,
  SectionHeader,
  Select,
  Surface,
  Tabs,
} from "@or-on/ui";
import { ArrowUpRight, RadioTower, Route } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";

import { errorMessage } from "../../i18n/error-message";
import { tenantDateFormatter } from "../../i18n/tenant-date-time";
import { useCapability } from "../access";
import { voiceMutation } from "./mutation";
import { summarizeVoiceSample } from "./voice-presentation";

type VoiceTab = "calls" | "numbers";

const LIVE_REFRESH_MS = 2_000;

function formatUsd(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    currency: "USD",
    maximumFractionDigits: 4,
    minimumFractionDigits: 4,
    style: "currency",
  }).format(value);
}

export function VoiceOverview({
  flows,
  numbers,
  reconciliation,
  sessions,
  timezone = "UTC",
}: {
  readonly flows: readonly FlowSummary[];
  readonly numbers: readonly PhoneNumberSummary[];
  readonly reconciliation: ReconciliationReport;
  readonly sessions: readonly VoiceSessionSummary[];
  readonly timezone?: string;
}) {
  const t = useTranslations();
  const canEdit = useCapability("voice:operate");
  const locale = useLocale();
  const dateTime = tenantDateFormatter(locale, timezone, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<VoiceTab>("calls");
  const [showNumberSetup, setShowNumberSetup] = useState(false);
  const numberForm = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [liveSessions, setLiveSessions] = useState(sessions);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const sample = summarizeVoiceSample(liveSessions);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [direction, setDirection] = useState("all");
  const visibleSessions = liveSessions.filter(
    (session) =>
      (status === "all" || session.status === status) &&
      (direction === "all" || session.direction === direction) &&
      `${session.session_id} ${session.provider} ${session.outcome ?? ""}`
        .toLocaleLowerCase(locale)
        .includes(query.trim().toLocaleLowerCase(locale)),
  );
  const flowNames = new Map(flows.map((flow) => [flow.flow_id, flow.name]));
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tab") === "numbers")
      setActiveTab("numbers");
  }, []);

  useEffect(() => setLiveSessions(sessions), [sessions]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;

    async function refresh() {
      request = new AbortController();
      try {
        const response = await fetch("/api/voice/sessions", {
          cache: "no-store",
          signal: request.signal,
        });
        if (response.ok) {
          const payload = (await response.json()) as VoiceSessionList;
          if (!stopped) {
            setLiveSessions(payload.items);
            setRefreshFailed(false);
          }
        } else if (!stopped) {
          setRefreshFailed(true);
        }
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          if (!stopped) setRefreshFailed(true);
        }
      } finally {
        if (!stopped) timer = setTimeout(() => void refresh(), LIVE_REFRESH_MS);
      }
    }

    timer = setTimeout(() => void refresh(), LIVE_REFRESH_MS);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      request?.abort();
    };
  }, []);

  useEffect(() => {
    if (showNumberSetup)
      numberForm.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [showNumberSetup]);

  async function register(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const allowedAddress = data.get("allowedAddress");
    if (typeof allowedAddress !== "string") {
      setError(t("voice.cidrRequired"));
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await voiceMutation("/api/voice/phone-numbers", {
        e164: data.get("e164"),
        flow_id: data.get("flowId"),
        allowed_addresses: [allowedAddress],
        mode: "simulator",
      });
      form.reset();
      router.refresh();
    } catch (caught) {
      setError(errorMessage(caught, t, "voice.registrationFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="voice-workspace">
      <section
        className="tenant-voice-summary"
        aria-label={t("voice.operations")}
      >
        <div>
          <Badge
            label={
              reconciliation.provider_enabled
                ? t("premiumVoice.providerConfigured")
                : t("voice.disabled")
            }
            tone={reconciliation.provider_enabled ? "warning" : "neutral"}
          />
        </div>
        <dl>
          <div>
            <dt>{t("premiumVoice.recentSample")}</dt>
            <dd>{liveSessions.length.toLocaleString(locale)}</dd>
          </div>
          <div>
            <dt>{t("premiumVoice.active")}</dt>
            <dd>{sample.active.toLocaleString(locale)}</dd>
          </div>
          <div>
            <dt>{t("voice.answered")}</dt>
            <dd>{sample.answered.toLocaleString(locale)}</dd>
          </div>
          <div>
            <dt>{t("voice.averageDuration")}</dt>
            <dd>
              {sample.averageSeconds === null
                ? t("common.notSet")
                : t("voice.seconds", { count: sample.averageSeconds })}
            </dd>
          </div>
        </dl>
        <small>
          {t("premiumVoice.sampleHint")} {t("premiumVoice.durationHint")}
        </small>
      </section>
      {refreshFailed ? (
        <p className="voice-refresh-note" role="status">
          {t("premiumVoice.refreshStale")}
        </p>
      ) : null}
      <div className="voice-context-nav">
        <Tabs
          activeId={activeTab}
          ariaLabel={t("voice.workspace")}
          direction={locale === "he" ? "rtl" : "ltr"}
          items={[
            {
              controls: "voice-calls-panel",
              count: liveSessions.length,
              id: "calls",
              label: t("voice.callsTab"),
              tabId: "voice-calls-tab",
            },
            {
              controls: "voice-numbers-panel",
              count: numbers.length,
              id: "numbers",
              label: t("voice.numbersTab"),
              tabId: "voice-numbers-tab",
            },
          ]}
          onChange={(id) => {
            setActiveTab(id as VoiceTab);
            const params = new URLSearchParams(window.location.search);
            params.set("tab", id);
            window.history.replaceState(
              null,
              "",
              `/voice?${params.toString()}`,
            );
          }}
        />
      </div>

      <section
        aria-labelledby="voice-calls-tab"
        className="voice-tab-panel"
        hidden={activeTab !== "calls"}
        id="voice-calls-panel"
        role="tabpanel"
      >
        <Surface className="voice-call-index">
          <SectionHeader title={t("voice.recent")} />
          <div className="tenant-register-toolbar tenant-call-filters">
            <Input
              id="voice-call-search"
              label={t("tenantOperations.search")}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Select
              id="voice-call-status"
              label={t("inbox.status")}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="all">{t("tenantOperations.allStates")}</option>
              {["started", "ended", "failed"].map((value) => (
                <option key={value} value={value}>
                  {value === "failed"
                    ? t("status.failed")
                    : t(`tenantOperations.${value}`)}
                </option>
              ))}
            </Select>
            <Select
              id="voice-call-direction"
              label={t("voice.direction")}
              value={direction}
              onChange={(event) => setDirection(event.target.value)}
            >
              <option value="all">{t("tenantOperations.allDirections")}</option>
              {["inbound", "outbound"].map((value) => (
                <option key={value} value={value}>
                  {t(`status.${value}`)}
                </option>
              ))}
            </Select>
            <p role="status">
              {t("tenantOperations.showing", {
                count: visibleSessions.length,
                total: liveSessions.length,
              })}
            </p>
          </div>
          {liveSessions.length === 0 ? (
            <EmptyState
              description={t("voice.simulatorFirst")}
              title={t("voice.empty")}
            />
          ) : visibleSessions.length === 0 ? (
            <p className="tenant-no-results">
              {t("tenantOperations.noMatches")}
            </p>
          ) : (
            <DataTable label={t("voice.recent")} minWidth="52rem">
              <thead>
                <tr>
                  <th scope="col">{t("voice.direction")}</th>
                  <th scope="col">{t("voice.session")}</th>
                  <th scope="col">{t("voice.outcome")}</th>
                  <th scope="col">{t("inbox.status")}</th>
                  <th scope="col">{t("voice.duration")}</th>
                  <th scope="col">{t("voice.estimatedCost")}</th>
                  <th scope="col">{t("voice.time")}</th>
                  <th scope="col">
                    <span className="or-visually-hidden">
                      {t("common.details")}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleSessions.map((session) => {
                  const duration =
                    typeof session.usage.call_seconds === "number" &&
                    Number.isFinite(session.usage.call_seconds)
                      ? Math.round(Math.max(0, session.usage.call_seconds))
                      : null;
                  return (
                    <tr key={session.session_id}>
                      <td>{t(`status.${session.direction}`)}</td>
                      <th scope="row">
                        <code dir="ltr">{session.session_id.slice(0, 8)}</code>
                        <small>{session.provider}</small>
                      </th>
                      <td>{session.outcome ?? t("voice.notRecorded")}</td>
                      <td>
                        <Badge
                          label={
                            t.has(`status.${session.status}`)
                              ? t(`status.${session.status}`)
                              : t("common.unknown")
                          }
                          tone={
                            session.status === "ended"
                              ? "positive"
                              : session.status === "failed"
                                ? "critical"
                                : "info"
                          }
                        />
                      </td>
                      <td>
                        {duration === null
                          ? t("common.notSet")
                          : t("voice.seconds", { count: duration })}
                      </td>
                      <td>
                        <span
                          aria-live={
                            session.status === "started" ? "polite" : "off"
                          }
                          className="voice-cost"
                        >
                          <strong dir="ltr">
                            {formatUsd(session.cost.total, locale)}
                          </strong>
                          <small>
                            {session.status === "started"
                              ? (session.cost.unpriced?.length ?? 0) > 0
                                ? t("voice.livePartialEstimate")
                                : t("voice.liveEstimate")
                              : (session.cost.unpriced?.length ?? 0) > 0
                                ? t("voice.partialEstimate")
                                : t("voice.completeEstimate")}
                          </small>
                        </span>
                      </td>
                      <td>
                        <time dateTime={session.created_at}>
                          {dateTime.format(new Date(session.created_at))}
                        </time>
                      </td>
                      <td>
                        <Link
                          className="text-link"
                          href={`/voice/calls/${session.session_id}`}
                        >
                          {t("voice.inspect")}
                          <ArrowUpRight aria-hidden="true" size={14} />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
        </Surface>
      </section>

      <section
        aria-labelledby="voice-numbers-tab"
        className="voice-tab-panel voice-number-workspace"
        hidden={activeTab !== "numbers"}
        id="voice-numbers-panel"
        role="tabpanel"
      >
        <Surface className="voice-number-index">
          <SectionHeader
            action={
              <div className="voice-number-actions">
                <Badge
                  label={
                    reconciliation.ok ? t("voice.coherent") : t("voice.drift")
                  }
                  tone={reconciliation.ok ? "positive" : "warning"}
                />
                <Button
                  aria-controls="voice-number-setup"
                  aria-expanded={showNumberSetup}
                  disabled={!canEdit}
                  onClick={() => setShowNumberSetup(true)}
                  size="small"
                  variant="secondary"
                >
                  {t("voice.numberSetup")}
                </Button>
              </div>
            }
            description={t("tenantOperations.routingScope")}
            title={t("tenantOperations.routing")}
          />
          <div className="voice-number-list">
            {numbers.length === 0 ? (
              <p className="muted">{t("voice.noNumbers")}</p>
            ) : (
              numbers.map((number) => (
                <article key={number.id}>
                  <span className="voice-number-list__icon" aria-hidden="true">
                    <RadioTower size={17} />
                  </span>
                  <div dir="ltr">
                    <strong>{number.e164}</strong>
                    <span dir="auto">
                      {t("tenantOperations.routeFlow")}:{" "}
                      {flowNames.get(number.flow_id) ?? number.flow_id}
                    </span>
                  </div>
                  <Badge
                    label={
                      t.has(`status.${number.admission}`)
                        ? t(`status.${number.admission}`)
                        : t("common.unknown")
                    }
                    tone="info"
                  />
                </article>
              ))
            )}
          </div>
        </Surface>

        <Dialog
          open={showNumberSetup}
          onClose={() => setShowNumberSetup(false)}
          title={t("voice.register")}
          closeLabel={t("common.close")}
          className="voice-number-registration"
        >
          <form
            className="feature-form"
            id="voice-number-setup"
            ref={numberForm}
            onSubmit={(event) => void register(event)}
          >
            <fieldset className="form-fieldset" disabled={pending || !canEdit}>
              {!canEdit ? (
                <p className="public-note">{t("common.readOnly")}</p>
              ) : null}
              <Input
                data-dialog-initial-focus
                dir="ltr"
                id="did-e164"
                label={t("voice.did")}
                name="e164"
                placeholder="+15550101010"
                required
              />
              <Select
                id="did-flow"
                label={t("voice.flow")}
                name="flowId"
                required
              >
                <option value="">{t("voice.select")}</option>
                {flows.map((flow) => (
                  <option key={flow.flow_id} value={flow.flow_id}>
                    {flow.name} · v{flow.latest_version}
                  </option>
                ))}
              </Select>
              <Input
                dir="ltr"
                id="did-acl"
                label={t("voice.cidr")}
                name="allowedAddress"
                placeholder="203.0.113.0/24"
                required
              />
              <Button
                busy={pending}
                disabled={!canEdit || flows.length === 0}
                type="submit"
              >
                <Route aria-hidden="true" size={15} />
                {t("voice.register")}
              </Button>
            </fieldset>
          </form>
          {error === undefined ? null : (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </Dialog>
      </section>
    </div>
  );
}
