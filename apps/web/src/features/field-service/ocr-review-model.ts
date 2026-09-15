import type {
  ServiceOcrQueueCounts,
  ServiceOcrQueueCursor,
  ServiceOcrQueueView,
} from "@or-on/crm";

export type OcrQueueView = ServiceOcrQueueView;

export function ocrQueueViewCount(
  counts: ServiceOcrQueueCounts,
  view: ServiceOcrQueueView,
): number {
  if (view === "attention") return counts.attention;
  if (view === "in_flight") return counts.inFlight;
  if (view === "completed") return counts.completed;
  return counts.all;
}

export function ocrQueueParameters(
  query: string,
  view: ServiceOcrQueueView,
  cursor?: ServiceOcrQueueCursor,
): URLSearchParams {
  const parameters = new URLSearchParams({ limit: "24", view });
  const trimmed = query.trim();
  if (trimmed !== "") parameters.set("q", trimmed);
  if (cursor !== undefined) {
    parameters.set("cursorStatus", cursor.status);
    parameters.set("cursorAt", cursor.createdAt);
    parameters.set("cursorId", cursor.id);
  }
  return parameters;
}
