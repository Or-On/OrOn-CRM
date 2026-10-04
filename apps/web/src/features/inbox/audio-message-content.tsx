"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { Message } from "@or-on/crm";

export function AudioMessageContent({
  message,
}: {
  readonly message: Message;
}) {
  const t = useTranslations();
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const media = message.media;
  if (media?.kind !== "audio") return null;
  const safeAudio =
    media.status === "available" &&
    (media.mimeType === "audio/ogg" || media.mimeType === "audio/wav");
  const transcription = media.transcriptionStatus ?? "unavailable";
  return (
    <div className="message-media message-media--audio">
      <span
        className="message-media__details"
        style={{ minWidth: 0, width: "100%" }}
      >
        <strong dir="auto">{media.fileName ?? t("inbox.media.audio")}</strong>
        {safeAudio && !playbackFailed ? (
          <audio
            controls
            preload="none"
            aria-label={t("inbox.media.playAudio")}
            style={{ width: "100%", maxWidth: 280 }}
            src={`/api/messaging/messages/${encodeURIComponent(message.id)}/media`}
            onError={() => setPlaybackFailed(true)}
          />
        ) : (
          <small role="status">
            {playbackFailed
              ? t("inbox.media.playbackFailed")
              : t(`inbox.media.status.${media.status}`)}
          </small>
        )}
        <small role="status">
          {t(`inbox.media.transcription.${transcription}`)}
        </small>
        {safeAudio ? (
          <a
            className="message-media__action"
            download
            href={`/api/messaging/messages/${encodeURIComponent(message.id)}/media`}
          >
            {t("inbox.media.downloadAudio")}
          </a>
        ) : null}
        {transcription === "completed" && message.contentText ? (
          <p dir="auto">{message.contentText}</p>
        ) : null}
      </span>
    </div>
  );
}
