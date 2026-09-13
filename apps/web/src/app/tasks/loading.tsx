import { LoadingSkeleton } from "@or-on/ui";
export default function TasksLoading() {
  return (
    <main className="page page--wide" aria-label="Loading tasks">
      <div className="workspace-route-loading">
        <LoadingSkeleton />
        <LoadingSkeleton />
        <LoadingSkeleton />
      </div>
    </main>
  );
}
