import type { HTMLAttributes } from "react";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly label: string;
  readonly tone?: "neutral" | "positive" | "warning" | "critical" | "info";
}

export function Badge({
  className = "",
  label,
  tone = "neutral",
  ...props
}: BadgeProps) {
  return (
    <span
      className={`or-badge or-badge--${tone} ${className}`.trim()}
      {...props}
    >
      <span aria-hidden="true" className="or-badge__marker" />
      {label}
    </span>
  );
}
