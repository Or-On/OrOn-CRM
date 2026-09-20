"use client";

import { useEffect, useRef, useState } from "react";

const imageUpdatedEvent = "or-on:identity-image-updated";

export function announceIdentityImageUpdate(
  source: string,
  contextKey?: string,
): void {
  window.dispatchEvent(
    new CustomEvent(imageUpdatedEvent, { detail: { source, contextKey } }),
  );
}

interface IdentityImageProps {
  readonly className?: string;
  readonly contextKey?: string | undefined;
  readonly fallback: string;
  readonly source: string;
}

export function IdentityImage(props: IdentityImageProps) {
  // The private endpoint resolves the authenticated tenant, not this key. A new
  // context remounts the image and changes its URL so a tenant switch cannot keep
  // displaying the previous workspace's loaded image.
  return (
    <IdentityImageContent
      {...props}
      key={`${props.source}:${props.contextKey ?? ""}`}
    />
  );
}

function IdentityImageContent({
  className = "",
  contextKey,
  fallback,
  source,
}: IdentityImageProps) {
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const media = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (
        event as CustomEvent<{ source: string; contextKey?: string }>
      ).detail;
      if (detail.source !== source || detail.contextKey !== contextKey) return;
      setLoaded(false);
      setRevision((previous) => previous + 1);
    };
    window.addEventListener(imageUpdatedEvent, refresh);
    return () => window.removeEventListener(imageUpdatedEvent, refresh);
  }, [source, contextKey]);

  useEffect(() => {
    const image = media.current;
    if (image?.complete)
      setLoaded(image.naturalWidth > 0 && image.naturalHeight > 0);
  }, [revision, source]);

  return (
    <span
      aria-hidden="true"
      className={`identity-image ${className}`.trim()}
      data-image-loaded={loaded || undefined}
    >
      {loaded ? null : (
        <span className="identity-image__fallback">{fallback}</span>
      )}
      {/* The authenticated blob endpoint has no stable dimensions or public
          optimizer URL; the native image preserves private no-store semantics. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        className="identity-image__media"
        data-loaded={loaded || undefined}
        key={revision}
        onError={() => setLoaded(false)}
        onLoad={() => setLoaded(true)}
        ref={media}
        src={`${source}${source.includes("?") ? "&" : "?"}v=${String(revision)}${contextKey ? `&context=${encodeURIComponent(contextKey)}` : ""}`}
      />
    </span>
  );
}
