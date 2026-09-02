// Generated from control-api OpenAPI. Do not edit by hand.

export interface DependencyStatus {
  readonly postgres: "ready" | "unavailable";
}

export type Direction = "inbound" | "outbound" | "browser";

export interface HTTPValidationError {
  readonly detail?: Array<ValidationError>;
}

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

export interface SimulatedCallRequest {
  readonly contact_id: string;
  readonly idempotency_key: string;
  readonly mode?: "simulator";
}

export interface SimulatedCallResult {
  readonly created: boolean;
  readonly event_types: Array<string>;
  readonly session: VoiceSessionSummary;
}

export interface ValidationError {
  readonly ctx?: Record<string, unknown>;
  readonly input?: unknown;
  readonly loc: Array<string | number>;
  readonly msg: string;
  readonly type: string;
}

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
