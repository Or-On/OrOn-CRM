import type { FlowSummary } from "@or-on/api-client";

export type CallingFlow = FlowSummary & { readonly agent_version?: number };

export function callFlowLabel(flow: CallingFlow, he: boolean): string {
  return flow.agent_version === undefined
    ? `${flow.name} · ${he ? "תסריט" : "Script"} v${String(flow.latest_version)}`
    : `${flow.name} · ${he ? "סוכן" : "Agent"} v${String(flow.agent_version)} · ${he ? "תסריט" : "Script"} v${String(flow.latest_version)}`;
}
