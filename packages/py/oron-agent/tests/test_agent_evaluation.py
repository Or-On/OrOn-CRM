"""Existing LLM adapter dependency injection proves no tool or provider substitution."""

import asyncio

import pytest
from oron_agent.agent_evaluation import RealEvaluationProvider
from oron_agent.config import Settings


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
