import type { CSSProperties } from "react";
import { product } from "../../branding";

interface BrandMarkProps {
  readonly className?: string;
  readonly size?: number;
}

/**
 * A code-native Or-On mark: one conversation signal moving through a stable
 * boundary. It intentionally contains no copied artwork or external asset.
 */
export function BrandMark({ className = "", size = 36 }: BrandMarkProps) {
  const style = { "--brand-mark-size": `${String(size)}px` } as CSSProperties;
  return (
    <svg
      aria-hidden="true"
      className={`brand__mark signal-mark ${className}`.trim()}
      focusable="false"
      height={size}
      style={style}
      viewBox="0 0 48 48"
      width={size}
    >
      <circle className="signal-mark__orbit" cx="24" cy="24" r="19" />
      <circle
        className="signal-mark__orbit signal-mark__orbit--inner"
        cx="24"
        cy="24"
        r="14"
      />
      <path
        className="signal-mark__trace"
        d="M5 25h10l4-9 6 18 5-13 4 7h9"
        pathLength="100"
      />
      <circle className="signal-mark__core" cx="25" cy="34" r="2.75" />
    </svg>
  );
}

export function BrandLockup({
  className = "",
  descriptor,
  markSize = 36,
}: {
  readonly className?: string;
  readonly descriptor?: string;
  readonly markSize?: number;
}) {
  return (
    <span className={`brand-lockup ${className}`.trim()}>
      <BrandMark size={markSize} />
      <span className="brand__copy brand-lockup__copy">
        <span className="brand__name">{product.name}</span>
        {descriptor ? <span className="brand__phase">{descriptor}</span> : null}
      </span>
    </span>
  );
}

/** Decorative signal paths; all meaning remains in adjacent HTML content. */
export function SignalBackdrop({
  className = "",
}: {
  readonly className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={`signal-backdrop ${className}`.trim()}
      focusable="false"
      preserveAspectRatio="none"
      viewBox="0 0 960 520"
    >
      <path
        className="signal-backdrop__path signal-backdrop__path--quiet"
        d="M-20 355C92 322 142 380 245 341s165-98 274-63 151 93 255 54 132-90 220-61"
        pathLength="100"
      />
      <path
        className="signal-backdrop__path signal-backdrop__path--active"
        d="M-20 389c123-24 182 44 294-9s151-151 270-89 148 154 256 89 132-130 194-110"
        pathLength="100"
      />
      <g className="signal-backdrop__waypoints">
        <circle cx="275" cy="380" r="5" />
        <circle cx="544" cy="291" r="5" />
        <circle cx="800" cy="380" r="5" />
      </g>
    </svg>
  );
}
