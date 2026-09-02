import os
import tempfile
import uuid
from pathlib import Path

from oron_flows import SPEED_MAX, SPEED_MIN, FlowStoreBackend, FlowVoice
from oron_flows.seeds import EXAMPLE_HE_ID
from pipecat.services.tts_service import TextAggregationMode
from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from oron_agent.audio import AudioInFilter, TurnEnd, TurnStart
from oron_agent.llm import LlmProvider
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
    # Only the dispatcher-less dev path reads this: with no DID there is no
    # binding to resolve a flow from, and pinning one packaged flow in code made
    # every other packaged flow unreachable by ear.
    dev_flow_id: uuid.UUID = Field(default=EXAMPLE_HE_ID, validation_alias="FLOW_ID")
    # Same dispatcher-less path: with no DID there is no tenant to resolve either.
    # Defaults to the tenant migration 0002 seeds, so it exists in every database.
    dev_tenant_id: uuid.UUID = Field(
        default=uuid.UUID("00000000-0000-0000-0000-000000000001"),
        validation_alias="TENANT_ID",
    )

    # The oron-sessions API. Always configured — persistence is not optional, and
    # the client fails soft on its own, so there is no "unconfigured" code path.
    sessions_api_host: str = Field(default="localhost", validation_alias="SESSIONS_API_HOST")
    sessions_api_port: int = Field(default=8080, validation_alias="SESSIONS_API_PORT")
    # Tenant-scoped API key. Required once the sessions API enforces tenancy —
    # without it every write 401s, and because the client is best-effort that
    # failure is silent: calls succeed and no session rows are ever written.
    sessions_api_key: SecretStr | None = Field(default=None, validation_alias="SESSIONS_API_KEY")

    # Where per-session recordings and transcripts go. The backend owns both the
    # URI scheme and the upload, so these cannot disagree. `local` is for dev —
    # on GKE it loses artifacts with the pod.
    artifacts_backend: ArtifactsBackend = Field(
        default=ArtifactsBackend.GCS, validation_alias="ARTIFACTS_BACKEND"
    )
    # Used by the gcs backend. Set per deployment — artifact URIs are derived
    # from it, so a wrong value produces rows naming a bucket nobody writes to.
    artifacts_bucket: str = Field(default="oron-artifacts", validation_alias="ARTIFACTS_BUCKET")
    # Used by the local backend.
    artifacts_local_root: str = Field(
        default_factory=lambda: str(Path(tempfile.gettempdir()) / "oron-artifacts"),
        validation_alias="ARTIFACTS_LOCAL_ROOT",
    )

    # A Google Cloud project is REQUIRED — the LLM (Vertex Gemini) and TTS run on it.
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
    # One throwaway inference at call setup so the caller's first turn hits a warm
    # prompt cache instead of paying ~4s. Read ONLY under `openai-compat`: Vertex
    # cached 0 tokens across 39 sessions, so warming it would buy an extra
    # inference and nothing else. True here means "warm where warming works".
    llm_warmup: bool = Field(default=True, validation_alias="LLM_WARMUP")
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
    # interval apart, then the call ends. 7s trades a thinking caller's pause for
    # the dead air a missed turn leaves — a caller who was not heard should not
    # wait 15s to find out.
    user_idle_secs: float = Field(default=7.0, validation_alias="USER_IDLE_SECS")
    # Silence that ends a caller's turn. 0.2 is what pipecat's built-in STT p99
    # values assume; above it every turn pays the difference and pipecat warns.
    vad_stop_secs: float = Field(default=0.2, validation_alias="VAD_STOP_SECS")
    # Stacks on TOP of vad_stop_secs, and ALWAYS runs to completion — the turn
    # cannot end sooner however fast STT is. Soniox finalizes 200-244ms after VAD
    # stop, so below ~0.25 there is nothing left to win. Not yet swept against
    # Hebrew callers, who pause on fillers: override per call to compare.
    user_speech_timeout: float = Field(default=0.3, validation_alias="USER_SPEECH_TIMEOUT")

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
    turn_start: TurnStart = Field(default=TurnStart.MIN_WORDS, validation_alias="TURN_START")
    # Who decides the caller finished. `vad` keeps our ~602ms floor; `soniox`
    # gives the decision to the STT model. Ships `vad` — this replaces the stage
    # every latency number is measured against, so it wants one call each way,
    # not a default.
    turn_end: TurnEnd = Field(default=TurnEnd.VAD, validation_alias="TURN_END")

    # Required: STT is Soniox, so a bot cannot run without it. Better to fail at
    # settings load than midway through pipeline construction on a live call.
    soniox_api_key: SecretStr = Field(default=SecretStr(""), validation_alias="SONIOX_API_KEY")
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
    tts_first_clause: bool = Field(default=True, validation_alias="TTS_FIRST_CLAUSE")
    # Soniox: ~310ms to first audio vs Gemini's ~830ms on Hebrew, warm.
    tts_provider: TtsProvider = Field(default=TtsProvider.SONIOX, validation_alias="TTS_PROVIDER")
    # Whether to point Hebrew before sending it to the vendor. On by default,
    # which is what shipped — but it has never been measured against either
    # vendor, and a voice trained on unpointed text may read the diacritics as
    # material rather than as vowels.
    tts_niqqud: bool = Field(default=True, validation_alias="TTS_NIQQUD")
    # 1.0 is the vendor's own pace. Hebrew read at an English cadence sounds
    # slow; bounded by the narrower of the two vendors' ranges (Soniox 0.7-1.3).
    tts_speed: float = Field(default=1.0, ge=SPEED_MIN, le=SPEED_MAX, validation_alias="TTS_SPEED")
    soniox_tts_model: str = Field(default="tts-rt-v1", validation_alias="SONIOX_TTS_MODEL")
    soniox_tts_voice_default: str = Field(
        default="Maya", validation_alias="SONIOX_TTS_VOICE_DEFAULT"
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

    # FlowStore backend selection. `file` (one JSON document) is the only backend
    # until MongoFlowStore ships (F2.2). Not read yet: the agent resolves the
    # packaged catalog in process and never calls store.load().
    flow_store_backend: FlowStoreBackend = Field(
        default=FlowStoreBackend.FILE, validation_alias="FLOW_STORE_BACKEND"
    )

    @model_validator(mode="after")
    def _soniox_turn_end_does_not_silently_drop_the_start_gate(self) -> Settings:
        """Soniox turn detection replaces BOTH ends, not just the stop.

        A service may recommend turn strategies only when the caller passed none,
        so `TURN_END=soniox` means passing none at all — and `TURN_START` goes
        with them. Soniox then opens a turn on the local VAD signal, which is
        exactly the trigger the word gate exists to suppress. Refused rather than
        honoured-then-discarded, which is how the gate sat dead for three deploys.

        Since the gate is now the default, `TURN_END=soniox` requires setting
        `TURN_START=vad` explicitly. That is the point: giving it up is a
        decision, not a side effect.
        """
        if self.turn_end is TurnEnd.SONIOX and self.turn_start is not TurnStart.VAD:
            raise ValueError(
                f"TURN_END=soniox cannot be combined with TURN_START={self.turn_start}: "
                "Soniox turn detection supplies both strategies, so the start gate "
                "would be dropped. Set TURN_START=vad to accept that, or keep "
                "TURN_END=vad."
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
            "livekit_url_configured": bool(self.livekit_url),
            "livekit_api_key": "[REDACTED]" if self.livekit_api_key.get_secret_value() else "unset",
            "livekit_api_secret": (
                "[REDACTED]" if self.livekit_api_secret.get_secret_value() else "unset"
            ),
            "soniox_api_key": "[REDACTED]" if self.soniox_api_key.get_secret_value() else "unset",
            "llm_api_key": "[REDACTED]" if self.llm_api_key.get_secret_value() else "unset",
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
    # The A/B this PR exists to lose or win: same call, same stack, aggregator
    # swapped. Without it the comparison costs an image build per arm.
    tts_text_aggregation: TextAggregationMode | None = None
    # Per-call so both arms can be compared on one stack.
    tts_first_clause: bool | None = None
    vad_stop_secs: float | None = None
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
