import os

import pytest
from oron_agent.audio import AudioInFilter, TurnEnd, TurnStart
from oron_agent.config import AgentOverrides, Settings, load_settings, settings_with
from oron_agent.storage import ArtifactsBackend
from pydantic import ValidationError


def test_loads_required_from_env(monkeypatch):
    monkeypatch.setenv("LIVEKIT_URL", "ws://localhost:7880")
    monkeypatch.setenv("LIVEKIT_API_KEY", "devkey")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "secret")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "jpost-english-avatar-dev")
    monkeypatch.setenv("SONIOX_API_KEY", "sx")
    st = load_settings()
    assert st.livekit_url == "ws://localhost:7880"
    assert st.google_cloud_project == "jpost-english-avatar-dev"
    assert st.livekit_room  # has a default
    assert st.tts_voice_default  # fallback when CallContext sets no voice
    assert st.vertex_location == "global"  # overridable per deployment region
    assert st.vertex_llm_model == "gemini-2.5-flash"
    assert st.vertex_thinking_budget == 0
    assert st.user_idle_secs == 10.0


def test_the_shipped_endpointing_defaults_are_the_evaluated_ones():
    """Read off the field defaults, not a loaded Settings: these two are the
    turn-latency knobs a developer tunes in their own .env, and asserting the
    instance makes the suite fail on their machine instead of on a real change."""
    defaults = Settings.model_fields
    assert defaults["turn_end"].default is TurnEnd.SONIOX
    assert defaults["vad_stop_secs"].default == 0.2  # what pipecat's STT p99s assume
    assert defaults["user_speech_timeout"].default == 0.5
    assert defaults["turn_start"].default is TurnStart.RESPONSIVE
    assert defaults["soniox_endpoint_latency_adjustment_level"].default == 2
    assert defaults["soniox_endpoint_sensitivity"].default == 0.15
    assert defaults["soniox_max_endpoint_delay_ms"].default == 1000


def test_voice_defaults_prefer_natural_tts_and_conservative_gendering():
    defaults = Settings.model_fields
    assert defaults["soniox_stt_model"].default == "stt-rt-v5"
    assert defaults["soniox_tts_model"].default == "tts-rt-v2"
    assert defaults["soniox_tts_voice_default"].default == "Harper"
    assert defaults["gender_required_seconds"].default == 1.5
    assert defaults["gender_confidence_threshold"].default == 0.9
    assert defaults["gender_confirmation_attempts"].default == 2
    assert defaults["gender_detection_enabled"].default is False


def test_gender_window_must_allow_every_confirmation_attempt():
    with pytest.raises(ValidationError, match="GENDER_MAX_SECONDS"):
        Settings(
            _env_file=None,
            gender_required_seconds=1.5,
            gender_retry_interval_seconds=1.0,
            gender_confirmation_attempts=3,
            gender_max_seconds=3.0,
        )


def test_vertex_location_and_model_are_overridable(monkeypatch):
    for k, v in (
        ("LIVEKIT_URL", "ws://x"),
        ("LIVEKIT_API_KEY", "k"),
        ("LIVEKIT_API_SECRET", "s"),
        ("GOOGLE_CLOUD_PROJECT", "p"),
        ("SONIOX_API_KEY", "sx"),
        ("VERTEX_LOCATION", "us-central1"),
        ("VERTEX_LLM_MODEL", "gemini-2.5-pro"),
    ):
        monkeypatch.setenv(k, v)
    st = load_settings()
    assert st.vertex_location == "us-central1"
    assert st.vertex_llm_model == "gemini-2.5-pro"


def test_missing_google_project_raises(monkeypatch):
    # A Google Cloud project is mandatory (LLM + TTS run on it).
    for k in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"):
        monkeypatch.setenv(k, "x")
    monkeypatch.setenv("ENABLE_REAL_VOICE_PROVIDERS", "true")
    monkeypatch.setenv("SONIOX_API_KEY", "x")
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


def test_sessions_api_url_is_built_from_host_and_port(monkeypatch):
    for k, v in (
        ("LIVEKIT_URL", "ws://x"),
        ("LIVEKIT_API_KEY", "k"),
        ("LIVEKIT_API_SECRET", "s"),
        ("GOOGLE_CLOUD_PROJECT", "p"),
        ("SONIOX_API_KEY", "sx"),
        ("SESSIONS_API_HOST", "oron-sessions"),
        ("SESSIONS_API_PORT", "9000"),
    ):
        monkeypatch.setenv(k, v)
    st = load_settings()
    assert st.sessions_api_host == "oron-sessions"
    assert st.sessions_api_port == 9000
    assert st.sessions_api_url == "http://oron-sessions:9000"


def test_dispatcherless_flow_has_no_fictional_default() -> None:
    assert Settings(_env_file=None).dev_flow_id is None
    assert Settings(_env_file=None).dev_tenant_id is None


def test_sessions_api_key_is_configurable(monkeypatch):
    """Without it the sessions API 401s every write, and the best-effort client
    swallows it — so this being unset is a silent data-loss bug."""
    for k, v in (
        ("LIVEKIT_URL", "ws://x"),
        ("LIVEKIT_API_KEY", "k"),
        ("LIVEKIT_API_SECRET", "s"),
        ("GOOGLE_CLOUD_PROJECT", "p"),
        ("SONIOX_API_KEY", "sx"),
        ("SESSIONS_API_KEY", "oron_secret123"),
    ):
        monkeypatch.setenv(k, v)
    assert load_settings().sessions_api_key.get_secret_value() == "oron_secret123"


def test_google_cloud_project_actually_governs_quota(monkeypatch):
    """GOOGLE_CLOUD_PROJECT must decide where Vertex/TTS bill.

    Without this, google-auth takes the quota project from the ADC file, so a
    developer whose gcloud happens to point elsewhere runs the agent against
    their configured project for everything except billing — which surfaces as a
    403 "API not enabled in <some other project>" mid-call, after the greeting
    has already been generated.
    """
    monkeypatch.delenv("GOOGLE_CLOUD_QUOTA_PROJECT", raising=False)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "the-configured-one")
    monkeypatch.setenv("LIVEKIT_URL", "ws://lk")
    monkeypatch.setenv("LIVEKIT_API_KEY", "k")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "s")
    monkeypatch.setenv("SONIOX_API_KEY", "x")

    load_settings()

    assert os.environ["GOOGLE_CLOUD_QUOTA_PROJECT"] == "the-configured-one"


def test_an_explicit_quota_project_is_left_alone(monkeypatch):
    """Someone deliberately splitting billing from the resource project keeps it."""
    monkeypatch.setenv("GOOGLE_CLOUD_QUOTA_PROJECT", "billing-project")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "resource-project")
    monkeypatch.setenv("LIVEKIT_URL", "ws://lk")
    monkeypatch.setenv("LIVEKIT_API_KEY", "k")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "s")
    monkeypatch.setenv("SONIOX_API_KEY", "x")

    load_settings()

    assert os.environ["GOOGLE_CLOUD_QUOTA_PROJECT"] == "billing-project"


def test_responsive_barge_in_ships_live_not_dormant(monkeypatch):
    """The shipped hybrid cuts bot audio on VAD while ordinary listening still
    waits for transcript evidence, rather than treating every noise as a turn."""
    for k, v in [
        ("LIVEKIT_URL", "ws://x"),
        ("LIVEKIT_API_KEY", "k"),
        ("LIVEKIT_API_SECRET", "s"),
        ("GOOGLE_CLOUD_PROJECT", "p"),
        ("SONIOX_API_KEY", "sx"),
    ]:
        monkeypatch.setenv(k, v)

    st = Settings()
    assert st.turn_start is TurnStart.RESPONSIVE
    assert st.interrupt_min_words == 1
    assert st.vad_confidence == 0.35
    assert st.vad_min_volume == 0.35
    assert st.audio_in_filter is AudioInFilter.RNNOISE


def test_a_word_gate_of_zero_is_refused_rather_than_silently_being_vad(monkeypatch):
    """`min_words=0` starts a turn on any speech — VAD wearing the name of a gate,
    and it reads as enabled everywhere an operator would look."""
    for k, v in [
        ("LIVEKIT_URL", "ws://x"),
        ("LIVEKIT_API_KEY", "k"),
        ("LIVEKIT_API_SECRET", "s"),
        ("GOOGLE_CLOUD_PROJECT", "p"),
        ("SONIOX_API_KEY", "sx"),
        ("TURN_START", "min_words"),
        ("INTERRUPT_MIN_WORDS", "0"),
    ]:
        monkeypatch.setenv(k, v)
    with pytest.raises(ValidationError, match="INTERRUPT_MIN_WORDS"):
        Settings()


def test_audio_front_end_knobs_are_per_call_overridable(monkeypatch):
    for k, v in [
        ("LIVEKIT_URL", "ws://x"),
        ("LIVEKIT_API_KEY", "k"),
        ("LIVEKIT_API_SECRET", "s"),
        ("GOOGLE_CLOUD_PROJECT", "p"),
        ("SONIOX_API_KEY", "sx"),
    ]:
        monkeypatch.setenv(k, v)
    from oron_agent.config import Settings

    st = Settings()
    tuned = settings_with(
        st, AgentOverrides(interrupt_min_words=2, audio_in_filter=AudioInFilter.NONE)
    )
    assert tuned.interrupt_min_words == 2
    assert tuned.audio_in_filter is AudioInFilter.NONE
    assert st.interrupt_min_words == 1  # original untouched


@pytest.mark.parametrize(
    "env_var, out_of_range",
    [("VAD_CONFIDENCE", "5"), ("VAD_CONFIDENCE", "-0.1"), ("VAD_MIN_VOLUME", "1.5")],
)
def test_settings_rejects_out_of_range_vad_probability(monkeypatch, env_var, out_of_range):
    """A probability outside [0,1] would never fire, leaving VAD deaf all deploy."""
    for k, v in [
        ("LIVEKIT_URL", "ws://x"),
        ("LIVEKIT_API_KEY", "k"),
        ("LIVEKIT_API_SECRET", "s"),
        ("GOOGLE_CLOUD_PROJECT", "p"),
        ("SONIOX_API_KEY", "sx"),
    ]:
        monkeypatch.setenv(k, v)
    monkeypatch.setenv(env_var, out_of_range)
    with pytest.raises(ValidationError):
        Settings()


def test_settings_rejects_negative_interrupt_min_words(monkeypatch):
    for k, v in [
        ("LIVEKIT_URL", "ws://x"),
        ("LIVEKIT_API_KEY", "k"),
        ("LIVEKIT_API_SECRET", "s"),
        ("GOOGLE_CLOUD_PROJECT", "p"),
        ("SONIOX_API_KEY", "sx"),
    ]:
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("INTERRUPT_MIN_WORDS", "-1")
    with pytest.raises(ValidationError):
        Settings()


@pytest.mark.parametrize(
    "kwargs",
    [
        {"vad_confidence": 5},
        {"vad_confidence": -0.1},
        {"vad_min_volume": 1.5},
        {"interrupt_min_words": -1},
    ],
)
def test_agent_overrides_rejects_out_of_range_values(kwargs):
    with pytest.raises(ValidationError):
        AgentOverrides(**kwargs)


def test_artifacts_default_to_portable_local_storage() -> None:
    assert Settings(_env_file=None).artifacts_backend is ArtifactsBackend.LOCAL
