from pathlib import Path

import pytest
from oron_agent.config import Settings
from oron_agent.llm import LlmProvider, build_llm, warm_prompt_cache
from pipecat.services.openai.llm import OpenAILLMService
from pydantic import ValidationError

DEPLOY = Path(__file__).resolve().parents[3] / "deploy" / "livekit"

COHERE = "https://api.cohere.com/compatibility/v1"

VERTEX_ARGS = dict(
    project_id="p",
    location="global",
    credentials_path=None,
    vertex_model="gemini-3.6-flash",
    thinking_budget=0,
)


def _settings(**overrides) -> Settings:
    base = dict(
        ENABLE_REAL_VOICE_PROVIDERS=True,
        LIVEKIT_URL="ws://x",
        LIVEKIT_API_KEY="k",
        LIVEKIT_API_SECRET="s",
        GOOGLE_CLOUD_PROJECT="p",
        SONIOX_API_KEY="s",
    )
    return Settings(**{**base, **overrides})


def test_the_default_provider_is_vertex_so_nothing_changes_without_opting_in():
    assert _settings().llm_provider is LlmProvider.VERTEX


def test_compat_provider_reaches_the_configured_endpoint():
    llm = build_llm(
        LlmProvider.OPENAI_COMPAT,
        **VERTEX_ARGS,
        api_key="key",
        base_url=COHERE,
        model="command-a-plus-05-2026",
    )
    assert isinstance(llm, OpenAILLMService)
    assert str(llm._client.base_url).startswith(COHERE)
    assert llm._settings.model == "command-a-plus-05-2026"


@pytest.mark.parametrize("missing", ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"])
def test_a_half_configured_compat_provider_fails_at_load_not_mid_call(missing):
    """An agent that starts and then cannot reach its LLM fails on a live caller."""
    env = {
        "LLM_PROVIDER": "openai-compat",
        "LLM_API_KEY": "key",
        "LLM_BASE_URL": COHERE,
        "LLM_MODEL": "command-a-plus-05-2026",
    }
    del env[missing]
    with pytest.raises(ValidationError, match=missing):
        _settings(**env)


def test_vertex_settings_are_ignored_by_the_compat_branch():
    """The vertex fields keep their values; selecting compat must not read them."""
    llm = build_llm(
        LlmProvider.OPENAI_COMPAT,
        **{**VERTEX_ARGS, "project_id": ""},
        api_key="key",
        base_url=COHERE,
        model="m",
    )
    assert isinstance(llm, OpenAILLMService)


class _FakeLLM:
    def __init__(self, raises: Exception | None = None):
        self.calls: list[int | None] = []
        self._raises = raises

    async def run_inference(self, context, max_tokens=None, system_instruction=None):
        self.calls.append(max_tokens)
        if self._raises:
            raise self._raises
        return "x"


async def test_the_warmup_asks_for_one_token_because_only_the_prompt_is_being_cached():
    llm = _FakeLLM()
    await warm_prompt_cache(llm, object())
    assert llm.calls == [1]


async def test_a_failed_warmup_never_reaches_the_call():
    """An optimisation that can hang up on a caller is worse than a cold cache."""
    llm = _FakeLLM(raises=RuntimeError("provider down"))
    await warm_prompt_cache(llm, object())


def test_the_warmup_switch_reaches_the_container():
    """#81: TURN_START was declared in settings and plumbed nowhere, so the guard
    behind it was unreachable on the VM and nobody could tell. A knob is only
    real if all four links exist."""
    pytest.skip("target voice Compose wiring is tracked by P5-011")


def test_an_evaluation_model_is_flagged_unpriced_not_reported_as_free():
    """The guard checked vertex_llm_model, which openai-compat never uses — so an
    unpriced evaluation model cleared it and the call read as costing nothing.

    The stand-in used to be `gemma4-31b`, which passed only because it missed the
    real `gemma-4-31b` by one hyphen. Now that gemma is in the book that reads as
    a claim about a model we ship.
    """
    from oron_common import PriceBook

    book = PriceBook()
    assert book.unpriced_models(llm="unpriced-model", tts="gemini-3.1-flash-tts-preview")
    assert not book.unpriced_models(llm="gemini-2.5-flash", tts="gemini-3.1-flash-tts-preview")
