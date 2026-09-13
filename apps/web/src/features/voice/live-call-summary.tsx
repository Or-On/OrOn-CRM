"use client";

import type { VoiceSessionDetail } from "@or-on/api-client";
import { Metric, SectionHeader, Surface } from "@or-on/ui";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { VoiceQualitySummary } from "./voice-quality-summary";
import { VoiceAIControls } from "./voice-ai-controls";

const LIVE_REFRESH_MS = 2_000;

function formatUsd(value: number | undefined, locale: string): string {
  return new Intl.NumberFormat(locale, {
    currency: "USD",
    maximumFractionDigits: 4,
    minimumFractionDigits: 4,
    style: "currency",
  }).format(value ?? 0);
}

export function LiveCallSummary({
  initial,
}: {
  readonly initial: VoiceSessionDetail;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [call, setCall] = useState(initial);

  useEffect(() => setCall(initial), [initial]);

  useEffect(() => {
    if (call.status !== "started") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;

    async function refresh() {
      request = new AbortController();
      try {
        const response = await fetch("/api/voice/session-detail", {
          body: JSON.stringify({ session_id: initial.session_id }),
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: request.signal,
        });
        if (response.ok) {
          const payload = (await response.json()) as VoiceSessionDetail;
          if (!stopped) setCall(payload);
        }
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          // Retain the last authenticated snapshot during transient refresh errors.
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
  }, [call.status, initial.session_id]);

  const isPartial = (call.cost.unpriced?.length ?? 0) > 0;
  const estimateLabel =
    call.status === "started"
      ? isPartial
        ? t("voice.livePartialEstimate")
        : t("voice.liveEstimate")
      : isPartial
        ? t("voice.partialEstimate")
        : t("voice.completeEstimate");

  return (
    <>
      <VoiceAIControls
        sessionId={call.session_id}
        active={call.status === "started"}
        provider={call.provider}
      />
      <section aria-label={t("voice.outcome")} className="voice-call-facts">
        <Metric label={t("voice.provider")} value={call.provider} />
        <Metric
          label={t("voice.outcome")}
          value={call.outcome ?? t("voice.notRecorded")}
        />
        <Metric
          label={t("voice.answered")}
          tone={call.answered === true ? "positive" : "neutral"}
          value={
            call.answered === null
              ? t("voice.notApplicable")
              : call.answered
                ? t("voice.yes")
                : t("voice.no")
          }
        />
        <Metric
          label={t("voice.duration")}
          value={t("voice.seconds", {
            count: Math.round(call.usage.call_seconds ?? 0),
          })}
        />
        <div aria-live={call.status === "started" ? "polite" : "off"}>
          <Metric
            detail={estimateLabel}
            label={t("voice.estimatedCost")}
            tone={isPartial ? "neutral" : "info"}
            value={formatUsd(call.cost.total, locale)}
          />
        </div>
      </section>

      <Surface className="voice-cost-inspector">
        <SectionHeader
          description={t("voice.costBreakdownHint")}
          title={t("voice.costBreakdown")}
        />
        <dl>
          <div>
            <dt>{t("voice.telephonyCost")}</dt>
            <dd dir="ltr">{formatUsd(call.cost.telephony, locale)}</dd>
            <meter
              aria-label={t("voice.telephonyCost")}
              min={0}
              max={call.cost.total || 1}
              value={call.cost.telephony ?? 0}
            />
          </div>
          <div>
            <dt>{t("voice.sttCost")}</dt>
            <dd dir="ltr">{formatUsd(call.cost.stt, locale)}</dd>
            <meter
              aria-label={t("voice.sttCost")}
              min={0}
              max={call.cost.total || 1}
              value={call.cost.stt ?? 0}
            />
          </div>
          <div>
            <dt>{t("voice.llmCost")}</dt>
            <dd dir="ltr">{formatUsd(call.cost.llm, locale)}</dd>
            <meter
              aria-label={t("voice.llmCost")}
              min={0}
              max={call.cost.total || 1}
              value={call.cost.llm ?? 0}
            />
          </div>
          <div>
            <dt>{t("voice.ttsCost")}</dt>
            <dd dir="ltr">{formatUsd(call.cost.tts, locale)}</dd>
            <meter
              aria-label={t("voice.ttsCost")}
              min={0}
              max={call.cost.total || 1}
              value={call.cost.tts ?? 0}
            />
          </div>
        </dl>
      </Surface>
      <VoiceQualitySummary events={call.events} />
    </>
  );
}
