import type { HTMLAttributes } from "react";

export interface StatusIndicatorProps extends HTMLAttributes<HTMLSpanElement> {
  readonly label: string;
  readonly tone?: "neutral" | "info" | "positive" | "warning" | "critical";
}

export function StatusIndicator({
  className = "",
  label,
  tone = "neutral",
  ...props
}: StatusIndicatorProps) {
  return (
    <span
      className={`or-status or-status--${tone} ${className}`.trim()}
      {...props}
    >
      <span aria-hidden="true" className="or-status__marker" />
      <span>{label}</span>
    </span>
  );
}
