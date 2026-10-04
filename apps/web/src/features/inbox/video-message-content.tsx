"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { Message } from "@or-on/crm";

export function VideoMessageContent({
  message,
}: {
  readonly message: Message;
}) {
  const t = useTranslations();
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const media = message.media;
  if (media?.kind !== "video") return null;
  const safeVideo =
    media.status === "available" && media.mimeType === "video/mp4";
  const url = `/api/messaging/messages/${encodeURIComponent(message.id)}/media`;
  return (
    <div
      className="message-media message-media--video"
      style={{ minWidth: 0, maxWidth: "100%" }}
    >
      <span
        className="message-media__details"
        style={{ minWidth: 0, width: "100%" }}
      >
        <strong dir="auto">{media.fileName ?? t("inbox.media.video")}</strong>
        {safeVideo && !playbackFailed ? (
          <video
            controls
            playsInline
            preload="none"
            aria-label={t("inbox.media.playVideo")}
            style={{
              width: "100%",
              maxWidth: 320,
              maxHeight: 360,
              objectFit: "contain",
            }}
            src={url}
            onError={() => setPlaybackFailed(true)}
          />
        ) : (
          <small role="status">
            {playbackFailed
              ? t("inbox.media.videoPlaybackFailed")
              : media.status === "available"
                ? t("inbox.media.videoUnsupported")
                : t(`inbox.media.status.${media.status}`)}
          </small>
        )}
        {media.caption ? <p dir="auto">{media.caption}</p> : null}
        {safeVideo ? (
          <a className="message-media__action" download href={url}>
            {t("inbox.media.downloadVideo")}
          </a>
        ) : null}
      </span>
    </div>
  );
}
