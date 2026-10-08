from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from oron_agent.llm import LlmProvider, build_llm
from pipecat.processors.aggregators.llm_context import LLMContext


def service():
    return build_llm(
        LlmProvider.OPENAI_COMPAT,
        project_id="fictional",
        location="global",
        credentials_path=None,
        vertex_model="unused",
        thinking_budget=0,
        api_key="fixture",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        model="gemini-3.5-flash-lite",
        fallback_model="gemini-3.1-flash-lite",
    )


class Stream:
    def __init__(self, chunks, error=None):
        self.chunks, self.error = chunks, error
        self.closed = False

    def __aiter__(self):
        return self.iterate()

    async def iterate(self):
        for chunk in self.chunks:
            yield chunk
        if self.error:
            raise self.error

    async def close(self):
        self.closed = True


@pytest.mark.parametrize("emitted", [False, True])
async def test_stream_retries_only_before_any_output_and_closes_failed_attempt(emitted):
    llm = service()
    recorded = AsyncMock()
    llm._on_attempt = recorded
    first = Stream(["partial-tool-delta"] if emitted else [], TimeoutError())
    second = Stream(["complete"])
    create = AsyncMock(side_effect=[first, second])
    llm._client = SimpleNamespace(
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        chat=SimpleNamespace(completions=SimpleNamespace(create=create)),
    )
    stream = await llm.get_chat_completions(
        LLMContext(messages=[{"role": "user", "content": "שלום"}])
    )
    result = []
    if emitted:
        with pytest.raises(TimeoutError):
            async for chunk in stream:
                result.append(chunk)
        assert result == ["partial-tool-delta"]
        assert create.await_count == 1
    else:
        async for chunk in stream:
            result.append(chunk)
        assert result == ["complete"]
        assert create.await_count == 2
        assert create.call_args_list[1].kwargs["model"] == "gemini-3.1-flash-lite"
        assert create.call_args_list[1].kwargs["reasoning_effort"] == "minimal"
        assert second.closed
    assert first.closed
    assert recorded.await_count == (1 if emitted else 2)
    failed = recorded.call_args_list[0].args[0]
    assert failed["model"] == "gemini-3.5-flash-lite"
    assert failed["status"] == "failed" and failed["partial"] is emitted
    assert failed["usage"] is None
    assert failed["latencyMs"] >= 0
    if not emitted:
        assert recorded.call_args_list[1].args[0]["model"] == "gemini-3.1-flash-lite"
        assert recorded.call_args_list[1].args[0]["status"] == "succeeded"
    assert create.call_args_list[0].kwargs["reasoning_effort"] == "minimal"
    assert "temperature" not in create.call_args_list[0].kwargs


def test_real_adapter_preserves_tool_identity_and_omits_deprecated_parameters():
    llm = service()
    call = {
        "id": "tool-1",
        "type": "function",
        "function": {"name": "lead_save_fields", "arguments": "{}"},
        "extra_content": {"google": {"thought_signature": "fixture-signature"}},
    }
    params = llm.build_chat_completion_params(
        {
            "model": "gemini-3.5-flash-lite",
            "messages": [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "tool_calls": [call]},
                {"role": "tool", "tool_call_id": "tool-1", "content": "saved"},
            ],
            "stream": True,
        }
    )
    assert params["messages"][1]["tool_calls"] == [call]
    assert params["messages"][2]["tool_call_id"] == "tool-1"
    assert not {"temperature", "top_p", "top_k"}.intersection(params)


async def test_nonstreaming_attempts_share_reservation_and_record_failed_usage_as_unknown():
    llm = service()
    llm._before_attempt = AsyncMock()
    llm._on_attempt = AsyncMock()
    completion = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content="OK"))], usage=None
    )
    create = AsyncMock(side_effect=[TimeoutError(), completion])
    llm._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    assert (
        await llm.run_inference(LLMContext(messages=[{"role": "user", "content": "Reply OK"}]))
        == "OK"
    )
    assert llm._before_attempt.await_count == 2
    assert llm._on_attempt.await_count == 2
    assert llm._on_attempt.call_args_list[0].args[0]["usage"] is None
    assert create.call_args_list[1].kwargs["model"] == "gemini-3.1-flash-lite"
    llm._before_attempt.side_effect = ValueError("revoked")
    with pytest.raises(ValueError, match="revoked"):
        await llm.run_inference(LLMContext(messages=[{"role": "user", "content": "Reply OK"}]))
    assert create.await_count == 2


@pytest.mark.parametrize("partial", [False, True])
async def test_empty_or_truncated_stream_does_not_replay_partial_output(partial):
    llm = service()
    llm._before_attempt = AsyncMock()
    llm._on_attempt = AsyncMock()
    role = SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(role="assistant", content=None, tool_calls=None),
                finish_reason=None,
            )
        ],
        usage=None,
    )
    token = SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(content="שלום", tool_calls=None), finish_reason=None
            )
        ],
        usage=None,
    )
    end = SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(content=None, tool_calls=None), finish_reason="length"
            )
        ],
        usage=None,
    )
    first = Stream([role, token, end] if partial else [role])
    second = Stream([token])
    create = AsyncMock(side_effect=[first, second])
    llm._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    stream = await llm.get_chat_completions(
        LLMContext(messages=[{"role": "user", "content": "שלום"}])
    )
    received = []
    if partial:
        from oron_agent.llm import IncompleteModelResponse

        with pytest.raises(IncompleteModelResponse):
            async for chunk in stream:
                received.append(chunk)
        assert create.await_count == 1
    else:
        async for chunk in stream:
            received.append(chunk)
        assert create.await_count == 2
    assert received == [token]
    assert first.closed
    assert llm._on_attempt.call_args_list[0].args[0]["status"] == "failed"


async def test_nonstreaming_truncation_uses_one_fallback_with_new_authorization():
    llm = service()
    llm._before_attempt = AsyncMock()
    llm._on_attempt = AsyncMock()
    responses = [
        SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=text), finish_reason=reason)],
            usage=None,
        )
        for text, reason in [("partial", "length"), ("complete", "stop")]
    ]
    create = AsyncMock(side_effect=responses)
    llm._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    assert (
        await llm.run_inference(LLMContext(messages=[{"role": "user", "content": "שלום"}]))
        == "complete"
    )
    assert llm._before_attempt.await_count == 2
    assert [item.args[0]["status"] for item in llm._on_attempt.call_args_list] == [
        "failed",
        "succeeded",
    ]


@pytest.mark.parametrize("streaming", [True, False])
async def test_failure_before_render_does_not_reuse_previous_instruction_hash(
    monkeypatch, streaming
):
    llm = service()
    llm._instruction_hash.set("a" * 64)
    llm._on_attempt = AsyncMock()

    def fail_before_render(*args, **kwargs):
        raise ValueError("invalid invocation fixture")

    monkeypatch.setattr(llm, "build_chat_completion_params", fail_before_render)
    context = LLMContext(messages=[{"role": "user", "content": "fixture"}])
    with pytest.raises(ValueError, match="invalid invocation fixture"):
        if streaming:
            stream = await llm.get_chat_completions(context)
            async for _ in stream:
                pass
        else:
            await llm.run_inference(context)
    assert llm._on_attempt.await_count == 1
    assert llm._on_attempt.call_args.args[0]["runtimeInstructionHash"] is None


async def test_primary_and_fallback_record_hash_of_exact_rendered_instructions():
    from oron_common.voice_instructions import instruction_text_snapshot

    llm = service()
    llm._on_attempt = AsyncMock()
    create = AsyncMock(side_effect=[Stream([], TimeoutError()), Stream(["complete"])])
    llm._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    stream = await llm.get_chat_completions(
        LLMContext(
            messages=[
                {"role": "system", "content": "הוראות בדיקה"},
                {"role": "user", "content": "fixture"},
            ]
        )
    )
    assert [chunk async for chunk in stream] == ["complete"]
    for invocation, recorded in zip(
        create.call_args_list, llm._on_attempt.call_args_list, strict=True
    ):
        instruction = invocation.kwargs["messages"][0]["content"]
        assert (
            recorded.args[0]["runtimeInstructionHash"]
            == instruction_text_snapshot(instruction)["hash"]
        )
        assert recorded.args[0]["compositionVersion"] == "effective-instructions.v1"
