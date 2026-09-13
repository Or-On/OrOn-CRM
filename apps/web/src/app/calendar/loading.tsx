import { LoadingSkeleton } from "@or-on/ui";
export default function CalendarLoading() {
  return (
    <main className="page page--wide" aria-label="Loading calendar">
      <div className="workspace-route-loading">
        <LoadingSkeleton />
        <LoadingSkeleton />
        <LoadingSkeleton />
      </div>
    </main>
  );
}
