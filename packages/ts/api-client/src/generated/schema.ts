// Generated from control-api OpenAPI. Do not edit by hand.

export interface DependencyStatus {
  readonly postgres: "ready" | "unavailable";
}

export type Direction = "inbound" | "outbound" | "browser";

export interface LiveStatus {
  readonly service: string;
  readonly status?: "alive";
  readonly version?: string;
}

export interface ReadyStatus {
  readonly dependencies: DependencyStatus;
  readonly service: string;
  readonly status: "ready" | "not_ready";
}

export type SessionStatus = "started" | "ended" | "failed";

export interface VoiceSessionList {
  readonly items: Array<VoiceSessionSummary>;
}

export interface VoiceSessionSummary {
  readonly answered: boolean | null;
  readonly contact_id: string | null;
  readonly created_at: string;
  readonly direction: Direction;
  readonly ended_at: string | null;
  readonly outcome: string | null;
  readonly platform_campaign_id: string | null;
  readonly provider: string;
  readonly session_id: string;
  readonly status: SessionStatus;
}
