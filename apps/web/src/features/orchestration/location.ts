export function orchestrationLocation(tab: string, search: string): string {
  const query = new URLSearchParams(search);
  query.set("tab", tab);
  return `/orchestration?${query.toString()}`;
}
