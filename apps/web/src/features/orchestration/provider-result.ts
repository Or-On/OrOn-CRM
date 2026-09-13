import type {
  AudioPreviewResult,
  AgentProviderEvaluationResult,
} from "@or-on/api-client";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}
function time(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 60000
  );
}
function base(value: Record<string, unknown>, versionId: string) {
  return (
    value.version_id === versionId &&
    typeof value.agent_id === "string" &&
    uuid.test(value.agent_id) &&
    typeof value.request_id === "string" &&
    uuid.test(value.request_id) &&
    bounded(value.provider, 80) &&
    bounded(value.model, 160)
  );
}

export function isAudioPreviewResult(
  value: unknown,
  versionId: string,
): value is AudioPreviewResult {
  return (
    object(value) &&
    base(value, versionId) &&
    value.evaluation_kind === "paid_tts_preview" &&
    value.media_type === "audio/wav" &&
    bounded(value.audio_base64, 2_700_000) &&
    value.audio_base64.length > 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value.audio_base64) &&
    bounded(value.voice, 120) &&
    bounded(value.canonical_text, 300) &&
    bounded(value.speech_normalized_text, 2000) &&
    time(value.duration_seconds) &&
    value.duration_seconds <= 30 &&
    value.expires_in_seconds === 60
  );
}

export function isAgentProviderEvaluationResult(
  value: unknown,
  versionId: string,
): value is AgentProviderEvaluationResult {
  return (
    object(value) &&
    base(value, versionId) &&
    value.evaluation_kind === "paid_typed_llm" &&
    bounded(value.accepted_text, 1000) &&
    bounded(value.response, 2000) &&
    bounded(value.decision, 80) &&
    time(value.model_ms) &&
    time(value.validation_ms) &&
    value.cost_usd === null &&
    value.recognized_text === null &&
    value.actions_executed === false &&
    Array.isArray(value.sources) &&
    value.sources.length <= 12 &&
    value.sources.every(
      (source: unknown) =>
        object(source) &&
        typeof source.source_id === "string" &&
        uuid.test(source.source_id) &&
        typeof source.document_id === "string" &&
        uuid.test(source.document_id) &&
        typeof source.version === "number" &&
        Number.isSafeInteger(source.version) &&
        source.version > 0 &&
        bounded(source.fact_key, 80),
    )
  );
}
