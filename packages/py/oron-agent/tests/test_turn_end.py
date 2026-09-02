"""Which end of the turn Soniox owns, and what taking it costs."""

import pytest
from oron_agent.audio import TurnEnd
from oron_agent.bot import build_user_aggregator_params
from oron_agent.config import Settings
from pipecat.services.soniox.stt import SonioxSTTService
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


def test_the_floor_is_what_ships():
    st = _settings()
    assert st.turn_end is TurnEnd.VAD
    assert build_user_aggregator_params(st).user_turn_strategies is not None


def test_soniox_turn_end_passes_no_strategies_at_all():
    """A service may only recommend strategies when we passed none. Ours always
    win — Soniox's recommendation is dropped with a debug line — so passing any
    here keeps our own floor while Soniox also emits turn frames, and the change
    buys nothing while looking applied."""
    params = build_user_aggregator_params(_settings(TURN_END="soniox", TURN_START="vad"))
    assert params.user_turn_strategies is None
    assert params.vad_analyzer is not None  # Soniox still opens the turn on it


def test_soniox_turn_end_refuses_to_silently_drop_the_word_gate():
    with pytest.raises(ValidationError, match="TURN_START"):
        _settings(TURN_END="soniox", TURN_START="min_words")


def test_soniox_turn_end_now_needs_the_gate_given_up_explicitly():
    """The gate became the default, so `TURN_END=soniox` alone no longer loads.
    That is the point: giving up the gate is a decision, not a side effect of
    changing the other end of the turn."""
    with pytest.raises(ValidationError, match="TURN_START"):
        _settings(TURN_END="soniox")


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
    """The recommendation is the mechanism: pipecat adopts it ONLY because we
    pass none. If Soniox stopped recommending, `TURN_END=soniox` would leave the
    turn with no stop strategy at all."""
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

    assert "vad_force_turn_endpoint=st.turn_end is TurnEnd.VAD" in inspect.getsource(bot.run_bot)


def test_compose_fallbacks_match_the_code_defaults():
    """docker-compose sets these env vars unconditionally, so its `:-` fallback
    OVERRIDES the Settings default rather than deferring to it. A fallback left
    behind a flipped default silently ships the old behaviour on any path where
    the env file lacks the var."""
    pytest.skip("target voice Compose fallback coverage is tracked by P5-011")
