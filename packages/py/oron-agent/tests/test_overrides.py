import uuid
from unittest.mock import AsyncMock, patch

import pytest
from oron_agent.bot import run_call
from oron_agent.config import (
    AgentOverrides,
    Settings,
    settings_for_call,
    settings_with,
)
from oron_agent.llm import LlmProvider
from oron_agent.tts import TtsProvider
from oron_common import CallContext
from oron_flows import FlowVoice
from pipecat.services.tts_service import TextAggregationMode
from pydantic import ValidationError


def _settings(**extra) -> Settings:
    return Settings(
        _env_file=None,
        ENABLE_REAL_VOICE_PROVIDERS=True,
        LIVEKIT_URL="ws://localhost:7880",
        LIVEKIT_API_KEY="APIoron",
        LIVEKIT_API_SECRET="secret_secret_secret_secret_secret_0",
        GOOGLE_CLOUD_PROJECT="proj",
        SONIOX_API_KEY="x",
        **extra,
    )


def test_an_override_replaces_only_the_field_it_names():
    tuned = settings_with(_settings(), AgentOverrides(vad_stop_secs=0.8))
    assert tuned.vad_stop_secs == 0.8
    assert tuned.vertex_llm_model == _settings().vertex_llm_model


def test_unset_knobs_leave_the_deployed_defaults_alone():
    base = _settings()
    assert settings_with(base, AgentOverrides()) == base


def test_overrides_do_not_mutate_the_shared_settings():
    base = _settings()
    settings_with(base, AgentOverrides(user_idle_secs=99.0))
    assert base.user_idle_secs == 10.0


def test_a_knob_outside_the_tunable_set_is_rejected():
    # Only the console's knobs are tunable per call — credentials and backends
    # are deployment config, not something a request may replace.
    with pytest.raises(ValueError):
        AgentOverrides(soniox_api_key="stolen")


def test_switching_provider_carries_its_endpoint_and_model():
    # The key is deployment config (LLM_API_KEY), never a browser knob.
    tuned = settings_with(
        _settings(LLM_API_KEY="deployed-key"),
        AgentOverrides(
            llm_provider=LlmProvider.OPENAI_COMPAT,
            llm_base_url="https://api.cohere.ai/compatibility/v1",
            llm_model="command-a",
        ),
    )
    assert tuned.llm_provider is LlmProvider.OPENAI_COMPAT
    assert (tuned.llm_model, tuned.llm_api_key.get_secret_value()) == (
        "command-a",
        "deployed-key",
    )


def test_a_half_configured_provider_switch_is_refused():
    """model_copy skips validation, so without a re-validate this would build an
    OpenAI client with no base_url and fail mid-call instead of at the request."""
    with pytest.raises(ValidationError):
        settings_with(_settings(), AgentOverrides(llm_provider=LlmProvider.OPENAI_COMPAT))


def test_the_api_key_is_not_a_knob():
    with pytest.raises(ValidationError):
        AgentOverrides(llm_api_key="from-the-browser")


async def test_run_call_runs_the_bot_with_the_tuned_settings():
    ctx = CallContext(
        call_id="call-abc", direction="inbound", flow_id=uuid.uuid4(), tenant_id=uuid.uuid4()
    )
    tuned = settings_with(_settings(), AgentOverrides(vertex_llm_model="gemini-3.6-pro"))
    with (
        patch("oron_agent.bot.LiveKitTransport"),
        patch("oron_agent.bot.run_bot", new=AsyncMock()) as mock_run_bot,
    ):
        await run_call("call-abc", ctx, tuned)

    assert mock_run_bot.await_args.args[2].vertex_llm_model == "gemini-3.6-pro"


def test_the_turn_wait_is_tunable_per_call():
    """The VM has no SSH, so a value that is only a deployed default costs an
    image build and an instance reset per candidate — which is why it never
    gets swept."""
    tuned = settings_with(_settings(), AgentOverrides(user_speech_timeout=0.6))
    assert tuned.user_speech_timeout == 0.6
    assert tuned.vad_stop_secs == _settings().vad_stop_secs


def test_text_aggregation_defaults_to_whole_sentences():
    """Token mode changes what every caller hears on a benefit nobody has
    measured yet, and Hebrew niqqud gets less context per aggregation."""
    assert _settings().tts_text_aggregation is TextAggregationMode.SENTENCE


def test_text_aggregation_is_tunable_per_call():
    """Both arms of the A/B have to run on one deployed image, or the comparison
    costs a build per arm and never gets run."""
    tuned = settings_with(
        _settings(), AgentOverrides(tts_text_aggregation=TextAggregationMode.TOKEN)
    )
    assert tuned.tts_text_aggregation is TextAggregationMode.TOKEN
    assert _settings().tts_text_aggregation is TextAggregationMode.SENTENCE


def test_a_flow_names_its_own_voice_and_the_deployment_yields():
    """The middle level: a flow that wants pointing off gets it, without an env
    change that would move every other flow on the deployment with it."""
    tuned = settings_for_call(
        _settings(), FlowVoice(tts_provider=TtsProvider.GEMINI, tts_niqqud=False), None
    )
    assert (tuned.tts_provider, tuned.tts_niqqud) == (TtsProvider.GEMINI, False)


def test_a_per_call_knob_still_beats_the_flow():
    """Otherwise the console's "this call only" is a lie for any flow that has
    an opinion, and there is no way to A/B a flow's own setting by ear."""
    tuned = settings_for_call(
        _settings(),
        FlowVoice(tts_provider=TtsProvider.GEMINI, tts_niqqud=False),
        AgentOverrides(tts_niqqud=True),
    )
    assert tuned.tts_niqqud is True
    assert tuned.tts_provider is TtsProvider.GEMINI  # untouched by the override


def test_a_flow_with_no_opinion_leaves_the_deployment_alone():
    base = _settings()
    assert settings_for_call(base, FlowVoice(), None) == base


def test_speed_reaches_the_call_from_the_flow():
    tuned = settings_for_call(_settings(), FlowVoice(tts_speed=1.2), None)
    assert tuned.tts_speed == 1.2


def test_a_speed_the_vendor_would_reject_is_refused_at_the_edge():
    """Soniox caps at 1.3. Out of range must fail where it is authored, not as a
    rejected websocket config mid-call."""
    with pytest.raises(ValidationError):
        FlowVoice(tts_speed=2.0)
    with pytest.raises(ValidationError):
        AgentOverrides(tts_speed=0.1)
