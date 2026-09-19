import os
import tempfile
import uuid
from pathlib import Path

from oron_flows import SPEED_MAX, SPEED_MIN, FlowVoice
from pipecat.services.tts_service import TextAggregationMode
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from oron_agent.audio import AudioInFilter, TurnEnd, TurnStart
from oron_agent.llm import LlmProvider, LlmReasoningEffort
from oron_agent.storage import ArtifactsBackend
from oron_agent.tts import TtsProvider


class Settings(BaseSettings):
    # Field names stay snake_case for Python; the env var each reads from is
    # declared explicitly via validation_alias (decoupled from the field name).
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", populate_by_name=True)

    enable_real_voice_providers: bool = Field(
        default=False, validation_alias="ENABLE_REAL_VOICE_PROVIDERS"
    )
    livekit_url: str = Field(default="", validation_alias="LIVEKIT_URL")
    livekit_api_key: SecretStr = Field(default=SecretStr(""), validation_alias="LIVEKIT_API_KEY")
    livekit_api_secret: SecretStr = Field(
        default=SecretStr(""), validation_alias="LIVEKIT_API_SECRET"
    )
    livekit_room: str = Field(default="oron-dev", validation_alias="LIVEKIT_ROOM")
    # Only the dispatcher-less development entrypoint reads this. It has no DID
    # from which to resolve a binding, so the operator must name an existing,
    # tenant-owned published flow explicitly. There is deliberately no example
    # flow default: a missing database configuration must fail before a call.
    dev_flow_id: uuid.UUID | None = Field(default=None, validation_alias="FLOW_ID")
    # The same dispatcher-less path also has no tenant binding. Requiring both
    # values prevents an explicit flow ID from being looked up under a silent
    # fixture/default tenant.
    dev_tenant_id: uuid.UUID | None = Field(default=None, validation_alias="TENANT_ID")

    # The oron-sessions API. Always configured — persistence is not optional, and
    # the client fails soft on its own, so there is no "unconfigured" code path.
    sessions_api_host: str = Field(default="localhost", validation_alias="SESSIONS_API_HOST")
    sessions_api_port: int = Field(default=8080, validation_alias="SESSIONS_API_PORT")
    # Tenant-scoped API key. Required once the sessions API enforces tenancy —
    # without it every write 401s, and because the client is best-effort that
    # failure is silent: calls succeed and no session rows are ever written.
    sessions_api_key: SecretStr | None = Field(default=None, validation_alias="SESSIONS_API_KEY")

    # Where per-session recordings and transcripts go. The backend owns both the
    # URI scheme and the upload, so these cannot disagree. Portable deployments
    # mount the local root on persistent storage; remote object storage is opt-in.
    artifacts_backend: ArtifactsBackend = Field(
        default=ArtifactsBackend.LOCAL, validation_alias="ARTIFACTS_BACKEND"
    )
    # Used by the gcs backend. Set per deployment — artifact URIs are derived
    # from it, so a wrong value produces rows naming a bucket nobody writes to.
    artifacts_bucket: str = Field(default="oron-artifacts", validation_alias="ARTIFACTS_BUCKET")
    # Used by the local backend.
    artifacts_local_root: str = Field(
        default_factory=lambda: str(Path(tempfile.gettempdir()) / "oron-artifacts"),
        validation_alias="ARTIFACTS_LOCAL_ROOT",
    )
    # Development-only redacted text-stage artifact. Production keeps this off;
    # the ordinary customer UI never reads or exposes it.
    text_diagnostics_enabled: bool = Field(default=False, validation_alias="VOICE_TEXT_DIAGNOSTICS")

    # Required only when the optional Vertex provider is selected.
    google_cloud_project: str = Field(default="", validation_alias="GOOGLE_CLOUD_PROJECT")

    vertex_location: str = Field(default="global", validation_alias="VERTEX_LOCATION")
    # 2.5, not 3.6: ~400ms faster to first token on this flow's own prompt, and
    # 3.6 bills reasoning at the response rate while the flow runs without it.
    vertex_llm_model: str = Field(default="gemini-2.5-flash", validation_alias="VERTEX_LLM_MODEL")
    # 0 disables thinking; a reasoning pass costs ~1.3s a voice turn cannot afford.
    vertex_thinking_budget: int = Field(default=0, validation_alias="VERTEX_THINKING_BUDGET")

    # Swaps the LLM for any OpenAI-compatible endpoint. The three llm_* fields
    # below are read only then, which is why they may be empty by default.
    llm_provider: LlmProvider = Field(default=LlmProvider.VERTEX, validation_alias="LLM_PROVIDER")
    llm_api_key: SecretStr = Field(default=SecretStr(""), validation_alias="LLM_API_KEY")
    llm_base_url: str = Field(default="", validation_alias="LLM_BASE_URL")
    llm_model: str = Field(default="", validation_alias="LLM_MODEL")
    # Voice turns need a fast reaction, not a hidden reasoning pass. This stays
    # unset for generic compatible providers; deployments opt in only when the
    # selected endpoint supports the OpenAI `reasoning_effort` parameter.
    llm_reasoning_effort: LlmReasoningEffort | None = Field(
        default=None, validation_alias="LLM_REASONING_EFFORT"
    )

    @field_validator("llm_reasoning_effort", mode="before")
    @classmethod
    def empty_reasoning_effort_is_unset(cls, value: object) -> object:
        return None if value == "" else value

    # A little variation sounds conversational without making tool selection or
    # collected details erratic. These settings apply only to openai-compat.
    llm_temperature: float = Field(default=0.4, ge=0.0, le=2.0, validation_alias="LLM_TEMPERATURE")
    # A hard ceiling prevents a voice turn becoming a monologue. The persona
    # remains the primary 1-2 sentence control; this is the last safety net.
    llm_max_tokens: int = Field(default=256, ge=32, le=2048, validation_alias="LLM_MAX_TOKENS")
    # Optional throwaway inference at call setup. Off by default: the current
    # Google compatibility endpoint showed no useful prompt-cache benefit, so a
    # warm-up added cost without making the first customer turn faster.
    llm_warmup: bool = Field(default=False, validation_alias="LLM_WARMUP")
    # How long a completion may produce nothing before the turn is abandoned.
    # Unbounded until now: the OpenAI SDK defaults to 600s, and on 2026-08-05 a
    # request that never sent a token held the pipeline for 21.8s until teardown.
    # Median time to first token is ~0.4s, so this is ~12x the normal case and
    # still an order of magnitude below the dead air it replaces. Read only under
    # `openai-compat`; Vertex has its own client.
    llm_request_timeout_secs: float = Field(
        default=5.0, gt=0.0, validation_alias="LLM_REQUEST_TIMEOUT_SECS"
    )
    # Silence before the caller is prompted; each `idle_prompts` entry fires one
    # interval apart, then the call ends. Ten seconds leaves a natural thinking
    # pause without returning to the old 15-second dead-air failure. Active user
    # and bot speech suspend the policy independently in UserIdlePoker.
    user_idle_secs: float = Field(default=10.0, validation_alias="USER_IDLE_SECS")
    # Silence that ends a caller's turn. 0.2 is what pipecat's built-in STT p99
    # values assume; above it every turn pays the difference and pipecat warns.
    vad_stop_secs: float = Field(default=0.2, validation_alias="VAD_STOP_SECS")
    # Stacks on TOP of vad_stop_secs, and ALWAYS runs to completion — the turn
    # cannot end sooner however fast STT is. Soniox finalizes 200-244ms after VAD
    # stop, so below ~0.25 there is little left to win. The previous 0.3s floor
    # cut off ordinary Hebrew pauses while 0.7s felt sluggish; 0.5s is the
    # bounded latency-only compromise, for roughly 0.7s total silence.
    user_speech_timeout: float = Field(default=0.5, validation_alias="USER_SPEECH_TIMEOUT")

    # How many transcribed words start a turn. Read only when turn_start is
    # `min_words`, where 0 would silently mean "no gate at all" — see the
    # validator below.
    interrupt_min_words: int = Field(default=1, ge=0, validation_alias="INTERRUPT_MIN_WORDS")
    # Swept over 33 recorded calls against offline-Soniox truth: 0.35 beats the
    # previous 0.5 on BOTH axes at once, so there is no tradeoff to argue.
    # Both are Silero probabilities, so out-of-[0,1] would silently mean "never fires".
    vad_confidence: float = Field(default=0.35, ge=0.0, le=1.0, validation_alias="VAD_CONFIDENCE")
    # Inert at this value: 0.0, 0.2 and 0.35 scored identically at every
    # confidence in the sweep, because silence itself measures ~0.29. Kept
    # because it does bite above ~0.5 — but tuning it below that does nothing.
    vad_min_volume: float = Field(default=0.35, ge=0.0, le=1.0, validation_alias="VAD_MIN_VOLUME")
    audio_in_filter: AudioInFilter = Field(
        default=AudioInFilter.RNNOISE, validation_alias="AUDIO_IN_FILTER"
    )
    # Krisp's own env names, so an operator following the vendor guide lands right.
    # Empty unless AUDIO_IN_FILTER=krisp; the key is a SECRET__ ref, the .kef a
    # licensed model file baked into the image.
    krisp_api_key: SecretStr = Field(default=SecretStr(""), validation_alias="KRISP_VIVA_API_KEY")
    krisp_filter_model_path: str = Field(
        default="", validation_alias="KRISP_VIVA_FILTER_MODEL_PATH"
    )
    krisp_ip_model_path: str = Field(default="", validation_alias="KRISP_VIVA_IP_MODEL_PATH")
    # What may interrupt the bot. `min_words` requires a transcribed word, which
    # is what stops re-triggered VAD killing the LLM mid-stream — the 16s of dead
    # air on the 2026-08-03 call, where the caller spoke five times and four
    # generations were started and thrown away.
    #
    # The cost is that STT becomes a hard dependency for EVERY turn, not just
    # barge-in: a turn starts only from a transcript, so if Soniox stalls the
    # caller cannot take a turn at all. No fallback is possible — the turn
    # controller takes the first strategy to fire, so any VAD strategy added to
    # cover it wins and defeats the gate. Rollback is this variable, not code.
    turn_start: TurnStart = Field(default=TurnStart.RESPONSIVE, validation_alias="TURN_START")
    # Who decides the caller finished. Soniox v5 uses semantic context rather
    # than a fixed silence floor, so it can wait through a dictated number while
    # ending a complete short answer promptly. The local transcript-based start
    # gate remains independent and still protects bot speech from wordless VAD.
    turn_end: TurnEnd = Field(default=TurnEnd.SONIOX, validation_alias="TURN_END")

    # Required: STT is Soniox, so a bot cannot run without it. Better to fail at
    # settings load than midway through pipeline construction on a live call.
    soniox_api_key: SecretStr = Field(default=SecretStr(""), validation_alias="SONIOX_API_KEY")
    # Pin the active real-time model explicitly rather than relying on the
    # Pipecat adapter's changing default. V5 improves telephony robustness and
    # semantic endpointing while remaining API-compatible with v4.
    soniox_stt_model: str = Field(default="stt-rt-v5", validation_alias="SONIOX_STT_MODEL")
    # Responsive semantic endpointing: level two and slight positive sensitivity
    # reduce the latest measured 1.6-2.0 second handoff while the semantic model
    # still sees context. The one-second cap bounds long end-of-turn waits.
    # These settings are used only when TURN_END=soniox.
    soniox_endpoint_latency_adjustment_level: int = Field(
        default=2,
        ge=0,
        le=3,
        validation_alias="SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL",
    )
    soniox_endpoint_sensitivity: float = Field(
        default=0.15,
        ge=-1.0,
        le=1.0,
        validation_alias="SONIOX_ENDPOINT_SENSITIVITY",
    )
    soniox_max_endpoint_delay_ms: int = Field(
        default=1000,
        ge=500,
        le=3000,
        validation_alias="SONIOX_MAX_ENDPOINT_DELAY_MS",
    )
    # Shortens the gaps BETWEEN WORDS only — Soniox documents it as distinct
    # from `speed`, and as untouched by sentence or punctuation pauses. Off
    # because the documented API default is off and because the field on a
    # model without `supports_silence_reduction` is an error, not a no-op: an
    # unnecessary `false` would be a live-call failure mode with no upside.
    tts_reduce_silence: bool = Field(default=False, validation_alias="TTS_REDUCE_SILENCE")
    google_application_credentials: str | None = Field(
        default=None, validation_alias="GOOGLE_APPLICATION_CREDENTIALS"
    )
    # `sentence` holds text to a boundary before synthesising; `token` speaks as
    # tokens arrive. Niqqud runs per aggregation, so token mode also points
    # Hebrew a word at a time — cheaper to first audio, less context to do it
    # with. aggregation_p50_ms is what the two arms differ by.
    tts_text_aggregation: TextAggregationMode = Field(
        default=TextAggregationMode.SENTENCE, validation_alias="TTS_TEXT_AGGREGATION"
    )
    # Speak the turn's opening clause without waiting for its sentence; off
    # falls back to whole sentences. The wait it removes is the largest slice of
    # a turn after the LLM's first token.
    tts_first_clause: bool = Field(default=False, validation_alias="TTS_FIRST_CLAUSE")
    # Soniox: ~310ms to first audio vs Gemini's ~830ms on Hebrew, warm.
    tts_provider: TtsProvider = Field(default=TtsProvider.SONIOX, validation_alias="TTS_PROVIDER")
    # Whether to point Hebrew before sending it to the vendor. Off until a
    # verified, checksum-pinned Renikud model is explicitly configured; the
    # setting alone cannot create niqqud and must not imply that it does.
    tts_niqqud: bool = Field(default=False, validation_alias="TTS_NIQQUD")
    # 1.0 is the vendor's own pace. Hebrew read at an English cadence sounds
    # slow; bounded by the narrower of the two vendors' ranges (Soniox 0.7-1.3).
    tts_speed: float = Field(default=1.0, ge=SPEED_MIN, le=SPEED_MAX, validation_alias="TTS_SPEED")
    soniox_tts_model: str = Field(default="tts-rt-v2", validation_alias="SONIOX_TTS_MODEL")
    soniox_tts_voice_default: str = Field(
        default="Harper", validation_alias="SONIOX_TTS_VOICE_DEFAULT"
    )
    # Not 2.5-flash-tts: ~250ms faster to first audio, clearly worse Hebrew.
    gemini_tts_model: str = Field(
        default="gemini-3.1-flash-tts-preview", validation_alias="GEMINI_TTS_MODEL"
    )
    # Fallback only — the live voice comes from CallContext.tts_voice per call.
    gemini_tts_voice_default: str = Field(
        default="Leda", validation_alias="GEMINI_TTS_VOICE_DEFAULT"
    )
    # Per-call bots should die when the call ends; this is the orphan safety net.
    agent_idle_timeout_secs: int = Field(default=60, validation_alias="AGENT_IDLE_TIMEOUT_SECS")
    # How long to wait for an outbound callee to pick up before greeting anyway.
    # Longer than a normal ring-to-answer; on timeout the call proceeds, because
    # a bot that never speaks is worse than one that speaks early.
    answer_timeout_secs: float = Field(default=45.0, validation_alias="ANSWER_TIMEOUT_SECS")
    # The greeting is the one sentence that must land, so the caller cannot talk
    # over it. The cap is a safety net: if the flow never greets, the hold must
    # not leave the agent deaf for the rest of the call.
    opener_hold_max_secs: float = Field(default=20.0, validation_alias="OPENER_HOLD_MAX_SECS")

    # Traces go to a self-hosted Phoenix over OTLP. Off by default: an endpoint
    # nobody is listening on makes every call log exporter retries.
    tracing_enabled: bool = Field(default=False, validation_alias="TRACING_ENABLED")
    otlp_endpoint: str = Field(default="http://127.0.0.1:4317", validation_alias="OTLP_ENDPOINT")

    renikud_model_path: str | None = Field(default=None, validation_alias="RENUKID_MODEL_PATH")
    renikud_model_sha256: str | None = Field(default=None, validation_alias="RENUKID_MODEL_SHA256")
    ecapa_model_path: str | None = Field(default=None, validation_alias="ECAPA_MODEL_PATH")
    ecapa_model_sha256: str | None = Field(default=None, validation_alias="ECAPA_MODEL_SHA256")
    # Telephone-band acoustic gender classification is not reliable enough to
    # change how a customer is addressed by default. Deployments may opt into
    # the retained classifier for controlled evaluation; the safe path stays
    # neutral and avoids loading the model entirely.
    gender_detection_enabled: bool = Field(
        default=False, validation_alias="GENDER_DETECTION_ENABLED"
    )
    # Gender changes Hebrew morphology, so a wrong confident guess is worse
    # than remaining neutral. Require two matching readings over more caller
    # speech before the result is allowed into the prompt and niqqud pipeline.
    gender_required_seconds: float = Field(
        default=1.5, gt=0.0, validation_alias="GENDER_REQUIRED_SECONDS"
    )
    gender_confidence_threshold: float = Field(
        default=0.9, ge=0.5, le=1.0, validation_alias="GENDER_CONFIDENCE_THRESHOLD"
    )
    gender_max_seconds: float = Field(default=4.0, gt=0.0, validation_alias="GENDER_MAX_SECONDS")
    gender_retry_interval_seconds: float = Field(
        default=0.75, gt=0.0, validation_alias="GENDER_RETRY_INTERVAL_SECONDS"
    )
    gender_confirmation_attempts: int = Field(
        default=2, ge=1, le=5, validation_alias="GENDER_CONFIRMATION_ATTEMPTS"
    )

    @model_validator(mode="after")
    def _gender_window_allows_confirmation(self) -> Settings:
        minimum_window = self.gender_required_seconds + (
            (self.gender_confirmation_attempts - 1) * self.gender_retry_interval_seconds
        )
        if self.gender_max_seconds < minimum_window:
            raise ValueError(
                "GENDER_MAX_SECONDS must allow the configured number of "
                "GENDER_CONFIRMATION_ATTEMPTS"
            )
        return self

    @model_validator(mode="after")
    def _the_word_gate_actually_gates(self) -> Settings:
        """`min_words=0` is not a gate, it is VAD wearing the name of one — and it
        reads as enabled everywhere an operator would look."""
        if self.turn_start is TurnStart.MIN_WORDS and self.interrupt_min_words < 1:
            raise ValueError(
                "TURN_START=min_words needs INTERRUPT_MIN_WORDS>=1; 0 starts a turn "
                "on any speech, which is TURN_START=vad."
            )
        return self

    @model_validator(mode="after")
    def _compat_provider_is_fully_configured(self) -> Settings:
        if self.llm_provider is LlmProvider.OPENAI_COMPAT:
            missing = [
                name
                for name, value in (
                    ("LLM_API_KEY", self.llm_api_key.get_secret_value()),
                    ("LLM_BASE_URL", self.llm_base_url),
                    ("LLM_MODEL", self.llm_model),
                )
                if not value
            ]
            if missing:
                raise ValueError(f"LLM_PROVIDER={self.llm_provider} needs {', '.join(missing)}")
        return self

    @model_validator(mode="after")
    def _google_reasoning_setting_matches_the_model(self) -> Settings:
        """Gemini 3 cannot disable thinking through the compatibility API."""
        if (
            "generativelanguage.googleapis.com" in self.llm_base_url
            and self.llm_model.startswith("gemini-3")
            and self.llm_reasoning_effort is LlmReasoningEffort.NONE
        ):
            raise ValueError(
                "LLM_REASONING_EFFORT=none is supported by Gemini 2.5 models, not Gemini 3; "
                "use gemini-2.5-flash for the lowest-latency voice path or set the effort to low"
            )
        return self

    @model_validator(mode="after")
    def _provider_execution_is_explicit_and_complete(self) -> Settings:
        if not self.enable_real_voice_providers:
            return self
        required = {
            "LIVEKIT_URL": self.livekit_url,
            "LIVEKIT_API_KEY": self.livekit_api_key.get_secret_value(),
            "LIVEKIT_API_SECRET": self.livekit_api_secret.get_secret_value(),
            "SONIOX_API_KEY": self.soniox_api_key.get_secret_value(),
        }
        if self.llm_provider is LlmProvider.VERTEX:
            required["GOOGLE_CLOUD_PROJECT"] = self.google_cloud_project
        missing = [name for name, value in required.items() if not value]
        if missing:
            raise ValueError(
                "ENABLE_REAL_VOICE_PROVIDERS=true requires " + ", ".join(sorted(missing))
            )
        for label, path, digest in (
            ("Renikud", self.renikud_model_path, self.renikud_model_sha256),
            ("ECAPA", self.ecapa_model_path, self.ecapa_model_sha256),
        ):
            if bool(path) != bool(digest):
                raise ValueError(f"{label} model path and SHA-256 must be configured together")
        return self

    @property
    def tts_voice_default(self) -> str:
        """Voice names are per-vendor, so the fallback follows the provider."""
        if self.tts_provider is TtsProvider.SONIOX:
            return self.soniox_tts_voice_default
        return self.gemini_tts_voice_default

    @property
    def tts_model(self) -> str:
        return (
            self.soniox_tts_model
            if self.tts_provider is TtsProvider.SONIOX
            else self.gemini_tts_model
        )

    @property
    def sessions_api_url(self) -> str:
        return f"http://{self.sessions_api_host}:{self.sessions_api_port}"

    def diagnostics(self) -> dict[str, object]:
        return {
            "enable_real_voice_providers": self.enable_real_voice_providers,
            "soniox_stt_model": self.soniox_stt_model,
            "livekit_url_configured": bool(self.livekit_url),
            "livekit_api_key": "[REDACTED]" if self.livekit_api_key.get_secret_value() else "unset",
            "livekit_api_secret": (
                "[REDACTED]" if self.livekit_api_secret.get_secret_value() else "unset"
            ),
            "soniox_api_key": "[REDACTED]" if self.soniox_api_key.get_secret_value() else "unset",
            "llm_api_key": "[REDACTED]" if self.llm_api_key.get_secret_value() else "unset",
            "tts_niqqud_requested": self.tts_niqqud,
            "tts_niqqud_model_configured": bool(self.renikud_model_path),
            "renikud_model_configured": bool(self.renikud_model_path),
            "ecapa_model_configured": bool(self.ecapa_model_path),
        }


class AgentOverrides(BaseModel):
    """The knobs a single call may retune, and nothing else. `extra="forbid"`
    is the point: credentials, backends and bucket names are deployment config,
    so a request naming one is a 422 rather than a silent swap.

    Every field is genuinely optional — absent means "keep what is deployed".
    """

    model_config = ConfigDict(extra="forbid")

    vertex_llm_model: str | None = None
    vertex_thinking_budget: int | None = None
    # A/B the two TTS vendors on a live call. The voice follows the provider's
    # own default unless the call names one, because "Leda" is not a Soniox voice.
    tts_provider: TtsProvider | None = None
    gemini_tts_model: str | None = None
    soniox_tts_model: str | None = None
    # Same call, same stack, pointing on or off — so the two can be told apart
    # by ear from the console instead of by an image build per arm.
    tts_niqqud: bool | None = None
    tts_speed: float | None = Field(default=None, ge=SPEED_MIN, le=SPEED_MAX)
    # Inter-word pause tightening, compared by ear on one call rather than by
    # rebuilding the image for each arm.
    tts_reduce_silence: bool | None = None
    # The A/B this PR exists to lose or win: same call, same stack, aggregator
    # swapped. Without it the comparison costs an image build per arm.
    tts_text_aggregation: TextAggregationMode | None = None
    # Per-call so both arms can be compared on one stack.
    tts_first_clause: bool | None = None
    vad_stop_secs: float | None = None
    # Soniox's three semantic-endpoint knobs. Tuning these is the one
    # measurement that CANNOT be made offline — it needs a caller finishing a
    # real Hebrew sentence — and the endpoint matrix was previously the only
    # turn-taking setting that still cost an image build and an instance reset
    # per candidate value. Same bounds as the deployment settings, so a console
    # sweep cannot leave the range Soniox accepts.
    soniox_endpoint_latency_adjustment_level: int | None = Field(default=None, ge=0, le=3)
    soniox_endpoint_sensitivity: float | None = Field(default=None, ge=-1.0, le=1.0)
    soniox_max_endpoint_delay_ms: int | None = Field(default=None, ge=500, le=3000)
    # The other half of the endpointing floor. Without it the two cannot be
    # compared from the console, and the VM has no SSH — every candidate value
    # would otherwise cost an image build and an instance reset.
    user_speech_timeout: float | None = None
    user_idle_secs: float | None = None
    interrupt_min_words: int | None = Field(default=None, ge=0)
    vad_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    vad_min_volume: float | None = Field(default=None, ge=0.0, le=1.0)
    audio_in_filter: AudioInFilter | None = None
    turn_start: TurnStart | None = None
    # Point one call at a different LLM. `llm_api_key` is deliberately absent:
    # the key is deployment config, and the browser has no business holding it.
    llm_provider: LlmProvider | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None


def settings_with(settings: Settings, overrides: AgentOverrides) -> Settings:
    """A copy of `settings` with the named knobs replaced. The original is left
    alone — it is shared by every other call in flight.

    Re-validated rather than returned straight from `model_copy`, which skips
    validators: a provider switch missing its endpoint has to fail here, not
    halfway through a call the caller is already connected to.
    """
    tuned = settings.model_copy(update=overrides.model_dump(exclude_none=True))
    return Settings.model_validate(tuned.model_dump())


def settings_for_call(
    base: Settings, flow_voice: FlowVoice, overrides: AgentOverrides | None
) -> Settings:
    """Deployment default < flow < per-call override.

    The flow is applied first and the console's knobs on top, so an experiment
    still wins for the length of one call — which is the whole point of a knob
    that says "this call only".
    """
    # Named field by field rather than splatted: `tts_voice` is not a Settings
    # knob — the voice is chosen per call against the provider's own default, so
    # it stays on the flow spec and is read where the service is built.
    tuned = settings_with(
        base,
        AgentOverrides(
            tts_provider=flow_voice.tts_provider,
            tts_niqqud=flow_voice.tts_niqqud,
            tts_speed=flow_voice.tts_speed,
        ),
    )
    return settings_with(tuned, overrides) if overrides else tuned


def load_settings() -> Settings:
    st = Settings()
    # Make GOOGLE_CLOUD_PROJECT mean what this class says it means. google-auth
    # otherwise takes the quota project from the ADC file, so an operator whose
    # gcloud points somewhere else runs the agent against the configured project
    # for everything *except* billing — and finds out mid-call, when TTS 403s
    # with "API not enabled in <someone else's project>" after the greeting has
    # already been composed and the caller is listening to silence. An explicit
    # value is honoured: splitting billing from the resource project is a real
    # choice; silently inheriting an unrelated one is not.
    if st.google_cloud_project:
        os.environ.setdefault("GOOGLE_CLOUD_QUOTA_PROJECT", st.google_cloud_project)
    return st
