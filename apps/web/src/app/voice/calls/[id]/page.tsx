import { productMetadata } from "../../../../i18n/product-metadata";
import { AccessDenied } from "../../../../i18n/access-denied";
import { getTranslations, getLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { Badge, Surface } from "@or-on/ui";

import {
  ForbiddenError,
  UnauthenticatedError,
} from "../../../../features/auth";
import { voiceClient } from "../../../../features/voice-server";

export default async function CallDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const t = await getTranslations();
  const locale = await getLocale();
  try {
    const { id } = await params;
    const result = await (
      await voiceClient("voice:read")
    ).getVoiceSession({ session_id: id });
    if (result.status === 404) notFound();
    const call = result.data;
    return (
      <main className="page page--wide">
        <header className="page-heading">
          <p className="eyebrow">{t("pages.callTitle")}</p>
          <h1>{call.session_id.slice(0, 8)}</h1>
          <p>{t("pages.callDescription")}</p>
        </header>
        <div className="voice-grid">
          <Surface level="raised">
            <div className="feature-heading">
              <h2>{t("voice.outcome")}</h2>
              <Badge
                label={t(`status.${call.status}`)}
                tone={call.status === "ended" ? "positive" : "info"}
              />
            </div>
            <dl className="detail-list">
              <div>
                <dt>{t("voice.provider")}</dt>
                <dd>{call.provider}</dd>
              </div>
              <div>
                <dt>{t("voice.outcome")}</dt>
                <dd>{call.outcome ?? t("voice.notRecorded")}</dd>
              </div>
              <div>
                <dt>{t("voice.answered")}</dt>
                <dd>
                  {call.answered === null
                    ? t("voice.notApplicable")
                    : call.answered
                      ? t("voice.yes")
                      : t("voice.no")}
                </dd>
              </div>
              <div>
                <dt>{t("voice.duration")}</dt>
                <dd>
                  {t("voice.seconds", { count: call.usage.call_seconds ?? 0 })}
                </dd>
              </div>
              <div>
                <dt>{t("voice.transcript")}</dt>
                <dd>
                  {call.transcript_object_id?.slice(0, 8) ?? t("voice.none")}
                </dd>
              </div>
              <div>
                <dt>{t("voice.recording")}</dt>
                <dd>
                  {call.recording_object_id?.slice(0, 8) ?? t("voice.none")}
                </dd>
              </div>
            </dl>
          </Surface>
          <Surface>
            <h2>{t("voice.lifecycle")}</h2>
            <ol className="timeline">
              {call.events.map((event) => (
                <li key={`${String(event.sequence)}-${event.event_type}`}>
                  <div>
                    <strong>{event.event_type}</strong>
                    <time dateTime={event.occurred_at}>
                      {new Date(event.occurred_at).toLocaleString(locale)}
                    </time>
                  </div>
                  <details className="technical-details">
                    <summary>{t("voice.technical")}</summary>
                    <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                  </details>
                </li>
              ))}
            </ol>
          </Surface>
        </div>
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const generateMetadata = () => productMetadata("call");
