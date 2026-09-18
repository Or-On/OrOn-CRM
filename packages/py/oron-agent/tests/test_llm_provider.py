from pathlib import Path

import pytest
from oron_agent.config import Settings
from oron_agent.llm import LlmProvider, LlmReasoningEffort, build_llm, warm_prompt_cache
from pipecat.services.openai.llm import OpenAILLMService
from pydantic import ValidationError

ENV_EXAMPLE = Path(__file__).resolve().parents[4] / ".env.example"

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
    # Unit tests must not inherit the operator's real local provider selection.
    return Settings(_env_file=None, **{**base, **overrides})


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


def test_compat_provider_receives_voice_latency_controls():
    llm = build_llm(
        LlmProvider.OPENAI_COMPAT,
        **VERTEX_ARGS,
        api_key="key",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        model="gemini-2.5-flash",
        reasoning_effort=LlmReasoningEffort.NONE,
        temperature=0.35,
        max_tokens=192,
    )
    params = llm.build_chat_completion_params(
        {"model": "gemini-2.5-flash", "messages": [], "stream": True}
    )
    assert params["reasoning_effort"] == "none"
    assert params["temperature"] == 0.35
    assert params["max_tokens"] == 192
    assert "max_completion_tokens" not in params


def test_compat_provider_supplies_a_non_customer_turn_for_an_immediate_opener():
    """Gemini maps system messages to system_instruction and rejects an empty contents list."""
    llm = build_llm(
        LlmProvider.OPENAI_COMPAT,
        **VERTEX_ARGS,
        api_key="key",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        model="gemini-2.5-flash",
    )
    original = [{"role": "system", "content": "Trusted flow objective"}]
    params = llm.build_chat_completion_params({"messages": original})
    assert params["messages"][:-1] == original
    assert params["messages"][-1]["role"] == "user"
    assert "not customer speech" in params["messages"][-1]["content"]
    assert original == [{"role": "system", "content": "Trusted flow objective"}]


def test_compat_provider_does_not_inject_a_start_event_after_customer_speech():
    llm = build_llm(
        LlmProvider.OPENAI_COMPAT,
        **VERTEX_ARGS,
        api_key="key",
        base_url=COHERE,
        model="command-a-plus-05-2026",
    )
    messages = [
        {"role": "system", "content": "Trusted flow objective"},
        {"role": "user", "content": "hello"},
    ]
    params = llm.build_chat_completion_params({"messages": messages})
    assert params["messages"] == messages


def test_compat_provider_drops_empty_streamed_tool_placeholder_pair():
    """Gemini emits an empty tool delta before the named call on some turns.

    Pipecat retains both pairs; sending the placeholder back makes Google's
    OpenAI-compatible endpoint reject the next node because a native function
    response name cannot be empty.
    """
    llm = build_llm(
        LlmProvider.OPENAI_COMPAT,
        **VERTEX_ARGS,
        api_key="key",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        model="gemini-2.5-flash",
    )
    messages = [
        {"role": "user", "content": "I need help."},
        {
            "role": "assistant",
            "tool_calls": [
                {"id": "", "function": {"name": "", "arguments": "{}"}, "type": "function"}
            ],
        },
        {"role": "tool", "content": "IN_PROGRESS", "tool_call_id": ""},
        {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": "function-call-1",
                    "function": {"name": "continue_support_done", "arguments": "{}"},
                    "type": "function",
                }
            ],
        },
        {"role": "tool", "content": '{"status":"acknowledged"}', "tool_call_id": "function-call-1"},
    ]

    params = llm.build_chat_completion_params({"messages": messages})

    assert params["messages"] == [messages[0], messages[3], messages[4]]
    assert messages[1]["tool_calls"][0]["id"] == ""


def test_google_gemini_3_cannot_claim_thinking_is_disabled():
    with pytest.raises(ValidationError, match="Gemini 2.5"):
        _settings(
            LLM_PROVIDER="openai-compat",
            LLM_API_KEY="key",
            LLM_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai/",
            LLM_MODEL="gemini-3.8-flash",
            LLM_REASONING_EFFORT="none",
        )


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


def test_vertex_receives_the_same_output_budget_and_bounded_timeout(monkeypatch):
    import oron_agent.llm as module

    original = module._SingleInstructionVertexLLMService
    received = {}

    class ConstructorProbe:
        Settings = original.Settings
        ThinkingConfig = original.ThinkingConfig

        def __init__(self, **kwargs):
            received.update(kwargs)

    monkeypatch.setattr(module, "_SingleInstructionVertexLLMService", ConstructorProbe)
    build_llm(
        LlmProvider.VERTEX,
        **VERTEX_ARGS,
        api_key="",
        base_url="",
        model="",
        max_tokens=192,
        temperature=0.2,
        request_timeout_secs=4.5,
    )
    assert received["settings"].max_tokens == 192
    assert received["settings"].temperature == 0.2
    assert received["http_options"].timeout == 4500


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
    configured = {
        key: value
        for key, value in (
            line.split("=", 1)
            for line in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines()
            if "=" in line and not line.startswith("#")
        )
    }
    assert configured["LLM_WARMUP"] == str(Settings.model_fields["llm_warmup"].default).lower()


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
