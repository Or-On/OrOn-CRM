// Generated from control-api OpenAPI. Do not edit by hand.

export interface DependencyStatus {
  readonly postgres: "ready" | "unavailable";
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
