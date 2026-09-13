import type { ReactNode } from "react";

export interface MetricProps {
  readonly detail?: ReactNode;
  readonly label: ReactNode;
  readonly tone?: "neutral" | "info" | "positive" | "warning" | "critical";
  readonly value: ReactNode;
}

export function Metric({
  detail,
  label,
  tone = "neutral",
  value,
}: MetricProps) {
  return (
    <div className="or-metric" data-tone={tone}>
      <span className="or-metric__label">{label}</span>
      <strong className="or-metric__value">{value}</strong>
      {detail === undefined ? null : (
        <span className="or-metric__detail">{detail}</span>
      )}
    </div>
  );
}
