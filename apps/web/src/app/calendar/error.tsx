"use client";
import { Button, EmptyState } from "@or-on/ui";
export default function CalendarError({
  reset,
}: {
  readonly reset: () => void;
}) {
  return (
    <main className="page page--wide">
      <EmptyState
        title="Calendar could not be loaded"
        description="Check that the latest database migration is installed, then try again."
        action={<Button onClick={reset}>Try again</Button>}
      />
    </main>
  );
}
