// Generated from control-api OpenAPI. Do not edit by hand.

export interface AgentEvaluationSource {
  readonly document_id: string;
  readonly fact_key: string;
  readonly source_id: string;
  readonly version: number;
}

export interface AgentProviderEvaluationRequest {
  readonly agent_id: string;
  readonly confirmed: true;
  readonly text: string;
  readonly version_id: string;
}

export interface AgentProviderEvaluationResult {
  readonly accepted_text: string;
  readonly actions_executed?: false;
  readonly agent_id: string;
  readonly cost_usd?: null;
  readonly decision: string;
  readonly evaluation_kind?: "paid_typed_llm";
  readonly model: string;
  readonly model_ms: number;
  readonly provider: string;
  readonly recognized_text?: null;
  readonly request_id: string;
  readonly response: string;
  readonly sources: Array<AgentEvaluationSource>;
  readonly validation_ms: number;
  readonly version_id: string;
}

export interface AudioPreviewRequest {
  readonly agent_id: string;
  readonly confirmed: true;
  readonly text: string;
  readonly version_id: string;
}

export interface AudioPreviewResult {
  readonly agent_id: string;
  readonly audio_base64: string;
  readonly canonical_text: string;
  readonly duration_seconds: number;
  readonly evaluation_kind?: "paid_tts_preview";
  readonly expires_in_seconds?: 60;
  readonly media_type?: "audio/wav";
  readonly model: string;
  readonly provider: string;
  readonly request_id: string;
  readonly speech_normalized_text: string;
  readonly version_id: string;
  readonly voice: string;
}

export interface CallCost {
  readonly llm?: number;
  readonly stt?: number;
  readonly telephony?: number;
  readonly total: number;
  readonly tts?: number;
  readonly unpriced?: Array<string>;
}

export interface CallUsage {
  readonly call_seconds?: number;
  readonly carrier?: string;
  readonly llm_cached_prompt_tokens?: number;
  readonly llm_completion_tokens?: number;
  readonly llm_model?: string;
  readonly llm_prompt_tokens?: number;
  readonly stt_audio_seconds?: number;
  readonly tts_audio_seconds?: number;
  readonly tts_characters?: number;
  readonly tts_model?: string;
}

export interface CanonicalFlowContract {
  readonly channels: Array<"voice" | "whatsapp">;
  readonly edges: Array<CanonicalFlowEdge>;
  readonly nodes: Array<CanonicalFlowNode>;
  readonly schemaVersion: "1.0";
}

export interface CanonicalFlowEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface CanonicalFlowNode {
  readonly configuration?: Record<string, unknown>;
  readonly id: string;
  readonly type:
    "start" | "end" | "message.send" | "voice.call" | "crm.update" | "handoff";
}

export interface CanonicalFlowValidationResult {
  readonly adapters?: Record<string, unknown> | null;
  readonly errors: Array<string>;
  readonly valid: boolean;
}

export interface CompiledFlowAdapter {
  readonly edges: Array<CanonicalFlowEdge>;
  readonly nodes: Array<CanonicalFlowNode>;
  readonly schemaVersion: string;
}

export interface ComponentCatalog {
  readonly components: Array<Record<string, unknown>>;
  readonly spec_version: string;
}

export interface DependencyStatus {
  readonly postgres: "ready" | "unavailable";
}

export type Direction = "inbound" | "outbound" | "browser";

export interface FlowDocumentRequest {
  readonly source: Record<string, unknown>;
}

export interface FlowList {
  readonly items: Array<FlowSummary>;
}

export interface FlowPublishResult {
  readonly created: boolean;
  readonly flow: FlowSummary;
}

export interface FlowSummary {
  readonly flow_id: string;
  readonly language: string;
  readonly latest_version: number;
  readonly name: string;
  readonly packaged: boolean;
}

export interface FlowValidationResult {
  readonly errors: Array<string>;
  readonly normalized?: Record<string, unknown> | null;
  readonly valid: boolean;
}

export interface HTTPValidationError {
  readonly detail?: Array<ValidationError>;
}

export interface LiveStatus {
  readonly service: string;
  readonly status?: "alive";
  readonly version?: string;
}

export interface PhoneNumberList {
  readonly items: Array<PhoneNumberSummary>;
}

export interface PhoneNumberSummary {
  readonly admission: "simulated" | "provider_disabled" | "drifted";
  readonly dispatch_rule_id: string;
  readonly e164: string;
  readonly flow_id: string;
  readonly id: string;
}

export interface ReadyStatus {
  readonly dependencies: DependencyStatus;
  readonly service: string;
  readonly status: "ready" | "not_ready";
}

export interface ReconciliationReport {
  readonly findings: Array<string>;
  readonly ok: boolean;
  readonly provider_enabled?: boolean;
}

export interface RegisterPhoneNumberRequest {
  readonly allowed_addresses: Array<string>;
  readonly e164: string;
  readonly flow_id: string;
  readonly mode?: "simulator";
}

export type SessionStatus = "started" | "ended" | "failed";

export interface SimulatedCallRequest {
  readonly contact_id: string;
  readonly idempotency_key: string;
  readonly mode?: "simulator";
  readonly scenario?: "completed" | "no_answer" | "failed" | "cancelled";
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

export interface VoiceCampaignCreate {
  readonly flow_id: string;
  readonly max_attempts?: number;
  readonly max_concurrent?: number;
  readonly name: string;
  readonly timezone?: string;
  readonly weekday_hours?: Record<string, unknown>;
}

export interface VoiceCampaignList {
  readonly items: Array<VoiceCampaignSummary>;
}

export interface VoiceCampaignRun {
  readonly campaign_id: string;
}

export interface VoiceCampaignRunResult {
  readonly campaign: VoiceCampaignSummary;
  readonly created_calls: number;
  readonly skipped_contacts: number;
}

export interface VoiceCampaignSummary {
  readonly completed_calls: number;
  readonly created_at: string;
  readonly eligible_contacts: number;
  readonly flow_id: string;
  readonly id: string;
  readonly max_attempts: number;
  readonly max_concurrent: number;
  readonly name: string;
  readonly status: string;
}

export interface VoiceControlCommand {
  readonly expected_epoch: number;
  readonly idempotency_key: string;
  readonly mode: "paused" | "ai";
}

export interface VoiceControlStatus {
  readonly acknowledged_at?: string | null;
  readonly acknowledged_epoch?: number | null;
  readonly active: boolean;
  readonly can_operate: boolean;
  readonly command_id?: string | null;
  readonly desired_mode: "ai" | "paused";
  readonly epoch: number;
  readonly human_connection?: "not_managed";
  readonly resume_required?: boolean;
  readonly session_id: string;
  readonly status: "pending" | "applied" | "worker_unavailable";
  readonly worker_mode?: "ai" | "paused" | null;
}

export interface VoiceSessionDetail {
  readonly answered: boolean | null;
  readonly contact_id: string | null;
  readonly cost: CallCost;
  readonly created_at: string;
  readonly direction: Direction;
  readonly ended_at: string | null;
  readonly events: Array<VoiceSessionEvent>;
  readonly outcome: string | null;
  readonly platform_campaign_id: string | null;
  readonly provider: string;
  readonly recording_available: boolean;
  readonly recording_object_id: string | null;
  readonly session_id: string;
  readonly status: SessionStatus;
  readonly transcript_available: boolean;
  readonly transcript_object_id: string | null;
  readonly usage: CallUsage;
}

export interface VoiceSessionEvent {
  readonly event_type: string;
  readonly occurred_at: string;
  readonly payload: Record<string, unknown>;
  readonly sequence: number;
}

export interface VoiceSessionList {
  readonly items: Array<VoiceSessionSummary>;
}

export interface VoiceSessionLookup {
  readonly session_id: string;
}

export interface VoiceSessionSummary {
  readonly answered: boolean | null;
  readonly contact_id: string | null;
  readonly cost: CallCost;
  readonly created_at: string;
  readonly direction: Direction;
  readonly ended_at: string | null;
  readonly outcome: string | null;
  readonly platform_campaign_id: string | null;
  readonly provider: string;
  readonly session_id: string;
  readonly status: SessionStatus;
  readonly usage: CallUsage;
}
