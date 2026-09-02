import { notFound, redirect } from "next/navigation";

import { Badge, Surface } from "@or-on/ui";

import { UnauthenticatedError } from "../../../../features/auth";
import { voiceClient } from "../../../../features/voice-server";

export default async function CallDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
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
          <p className="eyebrow">Call detail</p>
          <h1>{call.session_id.slice(0, 8)}</h1>
          <p>
            Ordered lifecycle, safe transcript event, artifacts, latency, and
            usage from the canonical session.
          </p>
        </header>
        <div className="voice-grid">
          <Surface level="raised">
            <div className="feature-heading">
              <h2>Outcome</h2>
              <Badge
                label={call.status}
                tone={call.status === "ended" ? "positive" : "info"}
              />
            </div>
            <dl className="detail-list">
              <div>
                <dt>Provider</dt>
                <dd>{call.provider}</dd>
              </div>
              <div>
                <dt>Outcome</dt>
                <dd>{call.outcome ?? "Not recorded"}</dd>
              </div>
              <div>
                <dt>Answered</dt>
                <dd>
                  {call.answered === null
                    ? "Not applicable"
                    : call.answered
                      ? "Yes"
                      : "No"}
                </dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{call.usage.call_seconds ?? 0}s</dd>
              </div>
              <div>
                <dt>Transcript object</dt>
                <dd>{call.transcript_object_id?.slice(0, 8) ?? "None"}</dd>
              </div>
              <div>
                <dt>Recording object</dt>
                <dd>{call.recording_object_id?.slice(0, 8) ?? "None"}</dd>
              </div>
            </dl>
          </Surface>
          <Surface>
            <h2>Lifecycle timeline</h2>
            <ol className="timeline">
              {call.events.map((event) => (
                <li key={`${String(event.sequence)}-${event.event_type}`}>
                  <div>
                    <strong>{event.event_type}</strong>
                    <time dateTime={event.occurred_at}>
                      {new Date(event.occurred_at).toLocaleString()}
                    </time>
                  </div>
                  <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                </li>
              ))}
            </ol>
          </Surface>
        </div>
      </main>
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
