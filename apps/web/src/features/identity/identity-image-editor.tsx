"use client";

import { ImagePlus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState, type ChangeEvent } from "react";

import { errorMessage } from "../../i18n/error-message";
import { imageMutation } from "../crm";
import { announceIdentityImageUpdate, IdentityImage } from "./identity-image";
import { identityImageAccept } from "./image-upload";

const MAX_BYTES = 2 * 1024 * 1024;

export function IdentityImageEditor({
  chooseLabel,
  contextKey,
  fallback,
  failedLabel,
  hint,
  removeLabel,
  removedLabel,
  source,
  title,
  updatedLabel,
  variant = "avatar",
}: {
  readonly chooseLabel: string;
  readonly contextKey?: string | undefined;
  readonly fallback: string;
  readonly failedLabel: string;
  readonly hint: string;
  readonly removeLabel: string;
  readonly removedLabel: string;
  readonly source: string;
  readonly title: string;
  readonly updatedLabel: string;
  readonly variant?: "avatar" | "organization";
}) {
  const t = useTranslations();
  const mutationSource = contextKey
    ? `${source}${source.includes("?") ? "&" : "?"}context=${encodeURIComponent(contextKey)}`
    : source;
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{
    readonly tone: "error" | "success";
    readonly text: string;
  }>();

  function imageFailure(error: unknown): string {
    return errorMessage(
      error,
      (key) => (key === "identity-image-failure" ? failedLabel : t(key)),
      "identity-image-failure",
    );
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    if (
      !identityImageAccept.split(",").includes(file.type) ||
      file.size > MAX_BYTES
    ) {
      setFeedback({ tone: "error", text: failedLabel });
      event.target.value = "";
      return;
    }
    setPending(true);
    setFeedback(undefined);
    try {
      await imageMutation(mutationSource, { file, method: "PATCH" });
      announceIdentityImageUpdate(source, contextKey);
      setFeedback({ tone: "success", text: updatedLabel });
    } catch (error) {
      setFeedback({
        tone: "error",
        text: imageFailure(error),
      });
    } finally {
      setPending(false);
      event.target.value = "";
    }
  }

  async function remove() {
    setPending(true);
    setFeedback(undefined);
    try {
      await imageMutation(mutationSource, { method: "DELETE" });
      announceIdentityImageUpdate(source, contextKey);
      setFeedback({ tone: "success", text: removedLabel });
    } catch (error) {
      setFeedback({
        tone: "error",
        text: imageFailure(error),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="identity-image-editor" data-variant={variant}>
      <IdentityImage
        className="identity-image-editor__preview"
        contextKey={contextKey}
        fallback={fallback}
        source={source}
      />
      <div className="identity-image-editor__body">
        <strong>{title}</strong>
        <p>{hint}</p>
        <div className="identity-image-editor__actions">
          <button
            className="identity-image-editor__choose"
            disabled={pending}
            onClick={() => input.current?.click()}
            type="button"
          >
            <ImagePlus aria-hidden="true" size={15} />
            {chooseLabel}
          </button>
          <button
            className="identity-image-editor__remove"
            disabled={pending}
            onClick={() => void remove()}
            type="button"
          >
            <Trash2 aria-hidden="true" size={15} />
            {removeLabel}
          </button>
          <input
            accept={identityImageAccept}
            aria-label={chooseLabel}
            hidden
            onChange={(event) => void upload(event)}
            ref={input}
            type="file"
          />
        </div>
        {feedback ? (
          <p
            className="identity-image-editor__feedback"
            data-tone={feedback.tone}
            role={feedback.tone === "error" ? "alert" : "status"}
          >
            {feedback.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
