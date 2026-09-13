"use client";

import { useEffect, useRef, useState } from "react";

export interface AnimatedNumberProps {
  readonly value: number;
  readonly locale: string;
  readonly maximumFractionDigits?: number;
  readonly animateOnMount?: boolean;
}

/** Exact accessible value; only decorative digits interpolate when data changes. */
export function AnimatedNumber({
  value,
  locale,
  maximumFractionDigits = 0,
  animateOnMount = false,
}: AnimatedNumberProps) {
  const initialDisplay = animateOnMount && Number.isFinite(value) ? 0 : value;
  const [display, setDisplay] = useState(initialDisplay);
  const displayRef = useRef(initialDisplay);
  useEffect(() => {
    const preference =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : undefined;
    let frame = 0;
    const finish = () => {
      cancelAnimationFrame(frame);
      displayRef.current = value;
      setDisplay(value);
    };
    if (
      preference?.matches ||
      !Number.isFinite(value) ||
      !Number.isFinite(displayRef.current)
    ) {
      finish();
      return;
    }
    const start = performance.now();
    const from = displayRef.current;
    const animate = (now: number) => {
      const progress = Math.max(0, Math.min(1, (now - start) / 320));
      displayRef.current = from + (value - from) * (1 - (1 - progress) ** 3);
      setDisplay(displayRef.current);
      if (progress < 1) frame = requestAnimationFrame(animate);
    };
    if (from !== value) frame = requestAnimationFrame(animate);
    const changed = () => {
      if (preference?.matches) finish();
    };
    preference?.addEventListener("change", changed);
    return () => {
      cancelAnimationFrame(frame);
      preference?.removeEventListener("change", changed);
    };
  }, [animateOnMount, value]);
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits });
  return (
    <span className="or-animated-number">
      <span className="or-visually-hidden">{format.format(value)}</span>
      <span aria-hidden="true">{format.format(display)}</span>
    </span>
  );
}
