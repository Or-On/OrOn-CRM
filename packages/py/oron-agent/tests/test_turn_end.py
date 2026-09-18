"""Which end of the turn Soniox owns, and what taking it costs."""

from pathlib import Path

import pytest
from oron_agent.audio import ResponsiveUserTurnStartStrategy, TurnEnd
from oron_agent.bot import build_user_aggregator_params
from oron_agent.config import AgentOverrides, Settings, settings_with
from pipecat.services.soniox.stt import SonioxSTTService
from pipecat.turns.user_stop.external_user_turn_stop_strategy import (
    ExternalUserTurnStopStrategy,
)
from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import (
    SpeechTimeoutUserTurnStopStrategy,
)
from pydantic import ValidationError

BASE = dict(
    LIVEKIT_URL="ws://x",
    LIVEKIT_API_KEY="k",
    LIVEKIT_API_SECRET="s",
    GOOGLE_CLOUD_PROJECT="p",
    SONIOX_API_KEY="sx",
)


def _settings(**overrides) -> Settings:
    return Settings(**{**BASE, **overrides})


def test_semantic_endpointing_with_responsive_barge_in_is_what_ships():
    st = _settings()
    assert st.turn_end is TurnEnd.SONIOX
    strategies = build_user_aggregator_params(st).user_turn_strategies
    assert strategies is not None
    assert isinstance(strategies.start[0], ResponsiveUserTurnStartStrategy)
    assert isinstance(strategies.stop[0], ExternalUserTurnStopStrategy)


def test_vad_fallback_keeps_the_fixed_speech_timeout_strategy():
    strategies = build_user_aggregator_params(_settings(TURN_END="vad")).user_turn_strategies
    assert strategies is not None
    assert isinstance(strategies.start[0], ResponsiveUserTurnStartStrategy)
    assert isinstance(strategies.stop[0], SpeechTimeoutUserTurnStopStrategy)


@pytest.mark.parametrize(
    "turn_end, forces_pipecat_mode",
    [(TurnEnd.VAD, True), (TurnEnd.SONIOX, False)],
)
def test_the_switch_reaches_the_stt_service(turn_end, forces_pipecat_mode):
    """`vad_force_turn_endpoint` is the flag that enables Soniox's endpoint
    detection at all — it is sent as `enable_endpoint_detection` in the config
    message, so getting it wrong means the websocket never runs endpointing."""
    stt = SonioxSTTService(
        api_key="k",
        vad_force_turn_endpoint=turn_end is TurnEnd.VAD,
        settings=SonioxSTTService.Settings(),
    )
    assert stt._vad_force_turn_endpoint is forces_pipecat_mode
    recommended = stt.service_metadata_frame().user_turn_strategies
    assert (recommended is None) is forces_pipecat_mode


def test_soniox_recommends_external_strategies_only_in_its_own_mode():
    """Pipecat adopts the service recommendation only when we pass none."""
    stt = SonioxSTTService(
        api_key="k", vad_force_turn_endpoint=False, settings=SonioxSTTService.Settings()
    )
    assert stt.service_metadata_frame().user_turn_strategies is not None


def test_the_stt_service_is_built_from_the_setting_not_a_constant():
    """Constructing SonioxSTTService directly proves the flag works; it does not
    prove run_bot passes ours. Hardcoding `True` here left every other test in
    this file green."""
    import inspect

    from oron_agent import bot

    source = inspect.getsource(bot.run_bot)
    assert "vad_force_turn_endpoint=st.turn_end is TurnEnd.VAD" in source
    assert "model=st.soniox_stt_model" in source
    assert "enable_language_identification=True" in source
    assert "endpoint_latency_adjustment_level=" in source
    assert "endpoint_sensitivity=" in source
    assert "max_endpoint_delay_ms=" in source


def test_semantic_endpoint_controls_are_bounded_and_responsive():
    st = _settings()
    assert st.soniox_endpoint_latency_adjustment_level == 2
    assert st.soniox_endpoint_sensitivity == 0.15
    assert st.soniox_max_endpoint_delay_ms == 1000


def test_the_endpoint_matrix_can_be_swept_on_one_live_stack():
    """When a caller has finished a Hebrew sentence is the one measurement that
    cannot be made offline, so the three knobs have to be per-call. Without
    this each candidate value costs an image build and an instance reset, which
    is why the matrix was never actually swept."""
    tuned = settings_with(
        _settings(),
        AgentOverrides(
            soniox_endpoint_latency_adjustment_level=1,
            soniox_endpoint_sensitivity=-0.2,
            soniox_max_endpoint_delay_ms=1800,
        ),
    )

    assert tuned.soniox_endpoint_latency_adjustment_level == 1
    assert tuned.soniox_endpoint_sensitivity == -0.2
    assert tuned.soniox_max_endpoint_delay_ms == 1800
    # Deployment defaults are untouched by a per-call experiment.
    assert _settings().soniox_endpoint_sensitivity == 0.15


@pytest.mark.parametrize(
    "override",
    [
        {"soniox_endpoint_latency_adjustment_level": 4},
        {"soniox_endpoint_latency_adjustment_level": -1},
        {"soniox_endpoint_sensitivity": 1.5},
        {"soniox_max_endpoint_delay_ms": 400},
        {"soniox_max_endpoint_delay_ms": 5000},
    ],
)
def test_a_console_sweep_cannot_leave_the_range_soniox_accepts(override):
    """Out of range is not a slower agent, it is a rejected STT config message
    and a call that transcribes nothing."""
    with pytest.raises(ValidationError):
        AgentOverrides(**override)


def test_compose_fallbacks_match_the_code_defaults():
    """docker-compose sets these env vars unconditionally, so its `:-` fallback
    OVERRIDES the Settings default rather than deferring to it. A fallback left
    behind a flipped default silently ships the old behaviour on any path where
    the env file lacks the var."""
    configured = {
        key: value
        for key, value in (
            line.split("=", 1)
            for line in (Path(__file__).resolve().parents[4] / ".env.example")
            .read_text(encoding="utf-8")
            .splitlines()
            if "=" in line and not line.startswith("#")
        )
    }
    # `_env_file=None`: Settings otherwise loads the repository's own .env, which
    # `make bootstrap` creates and a developer then tunes — so this drift guard
    # was comparing .env.example against whatever that developer had set locally
    # rather than against the code defaults it exists to pin.
    settings = Settings(_env_file=None)
    assert configured["SONIOX_STT_MODEL"] == settings.soniox_stt_model
    assert configured["TURN_START"] == settings.turn_start
    assert configured["TURN_END"] == settings.turn_end
    assert int(configured["INTERRUPT_MIN_WORDS"]) == settings.interrupt_min_words
    # The endpoint matrix decides when the agent believes a Hebrew sentence
    # ended, so a documented value that no longer matches the code default
    # silently ships different turn-taking to anyone who copied this file.
    assert (
        int(configured["SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL"])
        == settings.soniox_endpoint_latency_adjustment_level
    )
    assert float(configured["SONIOX_ENDPOINT_SENSITIVITY"]) == settings.soniox_endpoint_sensitivity
    assert int(configured["SONIOX_MAX_ENDPOINT_DELAY_MS"]) == settings.soniox_max_endpoint_delay_ms
    assert (configured["TTS_REDUCE_SILENCE"] == "true") == settings.tts_reduce_silence
    assert (configured["TTS_FIRST_CLAUSE"] == "true") == settings.tts_first_clause
    assert configured["TTS_TEXT_AGGREGATION"] == settings.tts_text_aggregation
    assert float(configured["TTS_SPEED"]) == settings.tts_speed
    # The conversation-timing and Vertex knobs are documented here too, so the
    # same drift guard has to cover them: a fallback that no longer matches the
    # code default ships the old behaviour to anyone who copied this file.
    assert configured["VERTEX_LOCATION"] == settings.vertex_location
    assert configured["VERTEX_LLM_MODEL"] == settings.vertex_llm_model
    assert int(configured["VERTEX_THINKING_BUDGET"]) == settings.vertex_thinking_budget
    assert float(configured["USER_IDLE_SECS"]) == settings.user_idle_secs
    assert float(configured["OPENER_HOLD_MAX_SECS"]) == settings.opener_hold_max_secs
    assert float(configured["ANSWER_TIMEOUT_SECS"]) == settings.answer_timeout_secs
    assert int(configured["AGENT_IDLE_TIMEOUT_SECS"]) == settings.agent_idle_timeout_secs
