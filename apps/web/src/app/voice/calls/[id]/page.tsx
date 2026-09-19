import { productMetadata } from "../../../../i18n/product-metadata";
import { AccessDenied } from "../../../../i18n/access-denied";
import { getTranslations, getLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, FileText, Mic2 } from "lucide-react";

import { PageHeader, SectionHeader, StatusIndicator, Surface } from "@or-on/ui";

import {
  ForbiddenError,
  UnauthenticatedError,
} from "../../../../features/auth";
import {
  CallRecordingPlayer,
  LiveCallSummary,
  transcriptArtifactEntries,
  transcriptEntries,
} from "../../../../features/voice";
import {
  voiceClient,
  voiceTranscriptText,
} from "../../../../features/voice-server";

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
    const eventTranscript = transcriptEntries(call.events);
    const artifactText =
      eventTranscript.length === 0 && call.transcript_available
        ? await voiceTranscriptText(call.session_id)
        : null;
    const transcript = artifactText
      ? transcriptArtifactEntries(artifactText, call.created_at)
      : eventTranscript;
    return (
      <main className="page page--wide call-detail-page">
        <PageHeader
          actions={
            <Link className="or-button or-button--secondary" href="/voice">
              <ArrowLeft
                aria-hidden="true"
                className="directional-icon"
                size={16}
              />
              {t("voice.backToCalls")}
            </Link>
          }
          description={t("pages.callDescription")}
          eyebrow={t("pages.callTitle")}
          meta={
            <StatusIndicator
              label={t(`status.${call.status}`)}
              tone={call.status === "ended" ? "positive" : "info"}
            />
          }
          title={call.session_id.slice(0, 8)}
        />

        <div className="voice-investigation">
          <section
            className="voice-investigation__conversation"
            aria-label={t("premiumVoice.conversationRecord")}
          >
            <Surface className="voice-recording-stage">
              <SectionHeader
                description={t("voice.assetsHint")}
                title={t("premiumVoice.conversationRecord")}
              />
              {call.recording_available ? (
                <CallRecordingPlayer
                  label={t("voice.playRecording")}
                  sessionId={call.session_id}
                  unsupported={t("voice.audioUnsupported")}
                />
              ) : (
                <p className="voice-recording-unavailable">
                  <Mic2 aria-hidden="true" size={20} />
                  {t("premiumVoice.noRecording")}
                </p>
              )}
              <dl className="voice-artifact-facts">
                <div>
                  <FileText aria-hidden="true" size={18} />
                  <dt>{t("premiumVoice.transcriptFile")}</dt>
                  <dd>
                    {call.transcript_available
                      ? (call.transcript_object_id?.slice(0, 8) ??
                        t("voice.availableFile"))
                      : t("voice.none")}
                  </dd>
                </div>
                <div>
                  <Mic2 aria-hidden="true" size={18} />
                  <dt>{t("voice.recording")}</dt>
                  <dd>
                    {call.recording_available
                      ? (call.recording_object_id?.slice(0, 8) ??
                        t("voice.availableFile"))
                      : t("voice.none")}
                  </dd>
                </div>
              </dl>
            </Surface>

            <section
              className="voice-transcript"
              aria-labelledby="call-transcript-heading"
            >
              <header>
                <FileText aria-hidden="true" size={20} />
                <h2 id="call-transcript-heading">{t("voice.transcript")}</h2>
                <span>
                  {t("premiumVoice.recordedEvents", {
                    count: transcript.length,
                  })}
                </span>
              </header>
              {transcript.length === 0 ? (
                <p className="voice-transcript__empty">
                  {t("premiumVoice.noTranscriptText")}
                </p>
              ) : (
                <ol>
                  {transcript.map((entry) => (
                    <li key={entry.sequence}>
                      <div>
                        <span>
                          {entry.speaker ? (
                            <bdi>{entry.speaker}</bdi>
                          ) : (
                            t("premiumVoice.transcriptEntry")
                          )}
                        </span>
                        <time dateTime={entry.occurredAt}>
                          {new Date(entry.occurredAt).toLocaleTimeString(
                            locale,
                          )}
                        </time>
                      </div>
                      <p dir="auto">{entry.text}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <Surface className="call-detail-timeline voice-chronology">
              <SectionHeader
                description={t("voice.lifecycleHint")}
                title={t("voice.lifecycle")}
              />
              {call.events.length === 0 ? (
                <p className="muted">{t("voice.noEvents")}</p>
              ) : (
                <ol className="timeline">
                  {call.events.map((event) => (
                    <li key={`${String(event.sequence)}-${event.event_type}`}>
                      <span className="call-event-sequence">
                        {String(event.sequence).padStart(2, "0")}
                      </span>
                      <div>
                        <strong>{event.event_type}</strong>
                        <time dateTime={event.occurred_at}>
                          {new Date(event.occurred_at).toLocaleString(locale)}
                        </time>
                        <details className="technical-details">
                          <summary>{t("voice.technical")}</summary>
                          <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                        </details>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Surface>
          </section>
          <aside
            className="voice-investigation__inspector"
            aria-label={t("premiumVoice.callInspector")}
          >
            <LiveCallSummary initial={call} />
          </aside>
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
