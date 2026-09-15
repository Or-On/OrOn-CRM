"""Existing LLM adapter dependency injection proves no tool or provider substitution."""

import asyncio

import pytest
from oron_agent.agent_evaluation import (
    EvaluationSettings,
    RealEvaluationProvider,
    render_evaluation,
)
from oron_agent.config import Settings
from oron_agent.grounding import CONVERSATION
from pydantic import ValidationError


class LLM:
    def __init__(self):
        self.context = None
        self.closed = False

    async def run_inference(self, context, **kwargs):
        self.context = context
        return '{"kind":"conversation","intent":"clarify"}'

    async def cleanup(self):
        self.closed = True


async def test_uses_installed_llm_factory_pinned_bounds_with_no_tools():
    settings = Settings(
        _env_file=None,
        ENABLE_REAL_VOICE_PROVIDERS=True,
        LIVEKIT_URL="ws://127.0.0.1:7880",
        LIVEKIT_API_KEY="fixture",
        LIVEKIT_API_SECRET="fixture",
        SONIOX_API_KEY="fixture",
        GOOGLE_CLOUD_PROJECT="fixture",
    )
    llm = LLM()
    options = {}

    def factory(provider, **kwargs):
        options.update(kwargs)
        return llm

    provider = RealEvaluationProvider(settings_factory=lambda: settings, llm_factory=factory)
    result = await provider.evaluate(
        "Fictional scenario",
        {"system_prompt": "Tenant style", "quality": {}, "knowledge": []},
        "fictional",
        confirmed=True,
    )
    assert result.model == settings.vertex_llm_model and llm.closed
    assert options["max_tokens"] == 256 and options["request_timeout_secs"] <= 10
    assert not llm.context.tools
    assert "ZERO tools" in llm.context.messages[0]["content"]
    assert llm.context.messages[1]["content"] == "Fictional scenario"


@pytest.mark.parametrize(
    ("caller_text", "configured_language", "expected_protocol_language"),
    [
        ("Can you help me?", "he", "accepted caller turn is in English"),
        ("אפשר לעזור לי?", "en", "accepted caller turn is in Hebrew"),
    ],
)
async def test_provider_protocol_follows_current_typed_turn_language(
    caller_text, configured_language, expected_protocol_language
):
    settings = Settings(
        _env_file=None,
        ENABLE_REAL_VOICE_PROVIDERS=True,
        LIVEKIT_URL="ws://127.0.0.1:7880",
        LIVEKIT_API_KEY="fixture",
        LIVEKIT_API_SECRET="fixture",
        SONIOX_API_KEY="fixture",
        GOOGLE_CLOUD_PROJECT="fixture",
    )
    llm = LLM()
    provider = RealEvaluationProvider(
        settings_factory=lambda: settings, llm_factory=lambda *args, **kwargs: llm
    )

    await provider.evaluate(
        caller_text,
        {
            "system_prompt": "Tenant style",
            "quality": {"language": configured_language},
            "knowledge": [],
        },
        "fictional",
        confirmed=True,
    )

    assert expected_protocol_language in llm.context.messages[0]["content"]


@pytest.mark.parametrize(
    ("caller_text", "configured_language", "expected"),
    [
        ("blorp zangle froop", "he", CONVERSATION["en"]["clarify"]),
        ("בלה קשקוש פלופ", "en", CONVERSATION["he"]["clarify"]),
    ],
)
def test_evaluation_nonsense_is_clarified_in_the_callers_language(
    caller_text, configured_language, expected
):
    reply = render_evaluation(
        '{"kind":"conversation","intent":"unverified"}',
        {
            "system_prompt": "Tenant style",
            "quality": {"language": configured_language},
            "knowledge": [],
        },
        "fictional",
        caller_text=caller_text,
    )

    assert reply.text == expected
    assert reply.decision == "clarify"


async def test_existing_kill_flag_blocks_before_any_provider_construction():
    def forbidden(*args, **kwargs):
        raise AssertionError("provider constructed")

    provider = RealEvaluationProvider(
        settings_factory=lambda: Settings(_env_file=None), llm_factory=forbidden
    )
    with pytest.raises(PermissionError):
        await provider.evaluate("test", {}, "fixture", confirmed=True)
    with pytest.raises(ValueError):
        await provider.evaluate("test", {}, "fixture", confirmed=False)


async def test_default_evaluation_config_does_not_require_call_or_audio_secrets(monkeypatch):
    monkeypatch.setenv("ENABLE_REAL_VOICE_PROVIDERS", "true")
    monkeypatch.setenv("LLM_PROVIDER", "openai-compat")
    monkeypatch.setenv("LLM_API_KEY", "fixture-key")
    monkeypatch.setenv("LLM_BASE_URL", "https://example.invalid/v1")
    monkeypatch.setenv("LLM_MODEL", "fixture-model")
    for name in (
        "LIVEKIT_URL",
        "LIVEKIT_API_KEY",
        "LIVEKIT_API_SECRET",
        "SONIOX_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)

    llm = LLM()
    options = {}

    def factory(provider, **kwargs):
        options.update(kwargs)
        return llm

    result = await RealEvaluationProvider(llm_factory=factory).evaluate(
        "Fictional scenario",
        {"system_prompt": "Tenant style", "quality": {}, "knowledge": []},
        "fictional",
        confirmed=True,
    )

    assert result.provider == "openai-compat"
    assert result.model == "fixture-model"
    assert options["base_url"] == "https://example.invalid/v1"
    assert llm.closed


def test_enabled_evaluation_still_requires_the_selected_llm_config(monkeypatch):
    monkeypatch.setenv("ENABLE_REAL_VOICE_PROVIDERS", "true")
    monkeypatch.setenv("LLM_PROVIDER", "openai-compat")
    for name in ("LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"):
        monkeypatch.delenv(name, raising=False)

    with pytest.raises(ValidationError, match="LLM_API_KEY, LLM_BASE_URL, LLM_MODEL"):
        EvaluationSettings(_env_file=None)


@pytest.mark.parametrize("cancel", [False, True])
async def test_openai_compatible_http_pool_closed_on_success_and_cancellation(cancel):
    class Client:
        closed = False

        async def close(self):
            self.closed = True

    class CompatLLM(LLM):
        def __init__(self):
            super().__init__()
            self._client = Client()

        async def run_inference(self, context, **kwargs):
            if cancel:
                await asyncio.Event().wait()
            return await super().run_inference(context, **kwargs)

    llm = CompatLLM()
    settings = Settings(
        _env_file=None,
        ENABLE_REAL_VOICE_PROVIDERS=True,
        LIVEKIT_URL="ws://127.0.0.1:7880",
        LIVEKIT_API_KEY="fixture",
        LIVEKIT_API_SECRET="fixture",
        SONIOX_API_KEY="fixture",
        LLM_PROVIDER="openai-compat",
        LLM_API_KEY="fixture",
        LLM_BASE_URL="http://fixture.invalid",
        LLM_MODEL="fixture",
    )
    provider = RealEvaluationProvider(
        settings_factory=lambda: settings, llm_factory=lambda *args, **kwargs: llm
    )
    context = {"system_prompt": "Fixture", "quality": {}, "knowledge": []}
    if cancel:
        with pytest.raises(TimeoutError):
            async with asyncio.timeout(0.01):
                await provider.evaluate("Fixture", context, "fixture", confirmed=True)
    else:
        await provider.evaluate("Fixture", context, "fixture", confirmed=True)
    assert llm.closed and llm._client.closed
