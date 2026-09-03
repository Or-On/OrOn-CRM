"use client";

import { errorMessage } from "../../i18n/error-message";
import { useCapability } from "../access";
import { useTranslations, useLocale } from "next-intl";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import type {
  FlowSummary,
  PhoneNumberSummary,
  ReconciliationReport,
  VoiceSessionSummary,
} from "@or-on/api-client";
import { Badge, Button, Input, Surface } from "@or-on/ui";

import { voiceMutation } from "./mutation";

export function VoiceOverview({
  flows,
  numbers,
  reconciliation,
  sessions,
}: {
  readonly flows: readonly FlowSummary[];
  readonly numbers: readonly PhoneNumberSummary[];
  readonly reconciliation: ReconciliationReport;
  readonly sessions: readonly VoiceSessionSummary[];
}) {
  const t = useTranslations();
  const canEdit = useCapability("voice:operate");
  const locale = useLocale();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const completed = sessions.filter((item) => item.status === "ended").length;
  const answered = sessions.filter((item) => item.answered === true).length;

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
    <div className="voice-grid">
      <Surface level="raised">
        <div className="feature-heading">
          <div>
            <p className="eyebrow">{t("voice.simulatorFirst")}</p>
            <h2>{t("voice.operations")}</h2>
          </div>
          <Badge label={t("voice.disabled")} tone="neutral" />
        </div>
        <dl className="metric-grid">
          <div>
            <dt>{t("voice.calls")}</dt>
            <dd>{sessions.length}</dd>
          </div>
          <div>
            <dt>{t("voice.completed")}</dt>
            <dd>{completed}</dd>
          </div>
          <div>
            <dt>{t("voice.answered")}</dt>
            <dd>{answered}</dd>
          </div>
          <div>
            <dt>{t("voice.dids")}</dt>
            <dd>{numbers.length}</dd>
          </div>
        </dl>
        <div className="operation-list" aria-label={t("voice.recent")}>
          {sessions.length === 0 ? (
            <p>{t("voice.empty")}</p>
          ) : (
            sessions.map((session) => (
              <article key={session.session_id}>
                <div>
                  <strong>{session.session_id.slice(0, 8)}</strong>
                  <p>
                    {new Date(session.created_at).toLocaleString(locale)} ·{" "}
                    {session.provider}
                  </p>
                </div>
                <Badge
                  label={
                    t.has(`status.${session.status}`)
                      ? t(`status.${session.status}`)
                      : t("common.unknown")
                  }
                  tone={session.status === "ended" ? "positive" : "info"}
                />
                <Link
                  className="text-link"
                  href={`/voice/calls/${session.session_id}`}
                >
                  {t("voice.inspect")}
                </Link>
              </article>
            ))
          )}
        </div>
      </Surface>

      <Surface>
        <div className="feature-heading">
          <div>
            <p className="eyebrow">{t("voice.sip")}</p>
            <h2>{t("voice.numbers")}</h2>
          </div>
          <Badge
            label={reconciliation.ok ? t("voice.coherent") : t("voice.drift")}
            tone={reconciliation.ok ? "positive" : "warning"}
          />
        </div>
        <form
          className="feature-form"
          onSubmit={(event) => void register(event)}
        >
          <fieldset className="form-fieldset" disabled={pending || !canEdit}>
            {!canEdit ? (
              <p className="public-note">{t("common.readOnly")}</p>
            ) : null}
            <Input
              id="did-e164"
              label={t("voice.did")}
              name="e164"
              placeholder="+15550101010"
              required
            />
            <label htmlFor="did-flow">{t("voice.flow")}</label>
            <select id="did-flow" name="flowId" required>
              <option value="">{t("voice.select")}</option>
              {flows.map((flow) => (
                <option key={flow.flow_id} value={flow.flow_id}>
                  {flow.name} · v{flow.latest_version}
                </option>
              ))}
            </select>
            <Input
              id="did-acl"
              label={t("voice.cidr")}
              name="allowedAddress"
              placeholder="203.0.113.0/24"
              required
            />
            <Button
              disabled={pending || !canEdit || flows.length === 0}
              type="submit"
            >
              {t("voice.register")}
            </Button>
          </fieldset>
        </form>
        <div className="operation-list">
          {numbers.map((number) => (
            <article key={number.id}>
              <div dir="ltr">
                <strong>{number.e164}</strong>
                <p>{number.dispatch_rule_id}</p>
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
          ))}
        </div>
        {error === undefined ? null : (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </Surface>
    </div>
  );
}
