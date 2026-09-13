"use client";

import { useEffect, useRef, useState } from "react";

const imageUpdatedEvent = "or-on:identity-image-updated";

export function announceIdentityImageUpdate(source: string): void {
  window.dispatchEvent(new CustomEvent(imageUpdatedEvent, { detail: source }));
}

export function IdentityImage({
  className = "",
  fallback,
  source,
}: {
  readonly className?: string;
  readonly fallback: string;
  readonly source: string;
}) {
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const media = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== source) return;
      setLoaded(false);
      setRevision(Date.now());
    };
    window.addEventListener(imageUpdatedEvent, refresh);
    return () => window.removeEventListener(imageUpdatedEvent, refresh);
  }, [source]);

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
        src={`${source}?v=${String(revision)}`}
      />
    </span>
  );
}
