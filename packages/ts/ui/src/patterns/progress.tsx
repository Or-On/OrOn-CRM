export interface ProgressProps {
  readonly label: string;
  readonly max?: number;
  readonly value: number;
}

export function Progress({ label, max = 100, value }: ProgressProps) {
  const limit = Number.isFinite(max) && max > 0 ? max : 100;
  const bounded = Number.isFinite(value)
    ? Math.max(0, Math.min(value, limit))
    : 0;
  return (
    <div
      className="or-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={bounded}
    >
      <div className="or-progress__track">
        <span style={{ inlineSize: `${String((bounded / limit) * 100)}%` }} />
      </div>
      <span className="or-visually-hidden">
        {label}: {bounded} / {limit}
      </span>
    </div>
  );
}
