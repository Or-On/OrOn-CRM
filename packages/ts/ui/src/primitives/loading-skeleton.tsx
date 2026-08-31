export function LoadingSkeleton({
  label = "Loading",
}: {
  readonly label?: string;
}) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="or-skeleton"
      role="status"
    >
      <span className="or-visually-hidden">{label}</span>
    </div>
  );
}
