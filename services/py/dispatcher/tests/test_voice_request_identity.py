"""Tenant identity and CRM role in the serialized provider request, end to end.

Real: dispatcher prompt compilation (``get_flow``), flow binding and recovery,
FlowManager, context aggregators, evidence refresh, opener retirement and the
OpenAI-compatible request builder. Replaced: only the HTTP client, which records
each request and streams a fixture reply. Assertions are on what the provider
receives, never on generated wording.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from dispatcher_runtime.persistence import PostgresVoiceRuntime
from dispatcher_runtime.support_context import TenantSupportProfile
from openai.types.chat import ChatCompletionChunk
from oron_agent.context_hygiene import OpeningTurnContext
from oron_agent.flows import initial_node_from_spec
from oron_agent.flows.greeting import OPENING_TURN_PREFIX
from oron_agent.grounding import VoiceEvidenceContext
from oron_agent.llm import LlmProvider, build_llm
from oron_flows import FlowSpec
from pipecat.flows import FlowManager
from pipecat.frames.frames import EndFrame, LLMMessagesAppendFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.workers.runner import WorkerRunner

TENANT_A = TenantSupportProfile(
    displayName="Kav Or",
    supportDisplayName="קו אור תקשורת",
    primaryLanguage="he",
    supportedLanguages=["he", "en"],
)
TENANT_B = TenantSupportProfile(
    displayName="Beta Clinic",
    supportDisplayName="Beta Dental Clinic",
    primaryLanguage="en",
)


def _chunk(content=None, tool=None, finish=None) -> ChatCompletionChunk:
    delta: dict = {"role": "assistant"}
    if content is not None:
        delta["content"] = content
    if tool is not None:
        delta["tool_calls"] = [tool]
    return ChatCompletionChunk.model_validate(
        {
            "id": "c",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "fixture",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }
    )


class _Stream:
    def __init__(self, chunks):
        self._chunks = list(chunks)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._chunks:
            raise StopAsyncIteration
        return self._chunks.pop(0)

    async def close(self):
        return None


class _RecordingClient:
    def __init__(self, replies):
        self.requests: list[list[dict]] = []
        self._replies = list(replies)
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    async def _create(self, **params):
        self.requests.append(json.loads(json.dumps(params["messages"], default=str)))
        reply = self._replies.pop(0) if self._replies else ["<lang:he>בסדר."]
        return _Stream(
            [_chunk(tool=part) if isinstance(part, dict) else _chunk(part) for part in reply]
            + [_chunk(finish="stop")]
        )


def _stored_flow(*, broken_handler: bool = False) -> FlowSpec:
    return FlowSpec.model_validate(
        {
            "id": str(uuid.uuid4()),
            "version": 4,
            "entry": "support",
            "language": "he",
            "persona_gender": "female",
            # Retained demo persona: must never outrank the published agent.
            "role_message": "You are a demo assistant for Or-On.",
            "nodes": [
                {
                    "name": "support",
                    "task_messages": [{"role": "system", "content": "Help with the service."}],
                    "functions": [
                        {
                            "name": "billing_question",
                            "description": "The caller asks about billing.",
                            "handler": "missing_handler" if broken_handler else "goto",
                            "config": {"route": "billing"},
                            "routes": {"billing": "billing"},
                        }
                    ],
                },
                {
                    "name": "billing",
                    "role_message": "LEGACY NODE ROLE: you are Google support.",
                    "task_messages": [{"role": "system", "content": "Answer billing briefly."}],
                },
            ],
        }
    )


async def _call(profile, agent_prompt, replies, caller_turns, *, broken_handler=False):
    runtime = object.__new__(PostgresVoiceRuntime)
    runtime._flows = AsyncMock()  # pyrefly: ignore[bad-assignment]
    runtime._flows.load_latest.return_value = _stored_flow(broken_handler=broken_handler)
    spec = await runtime.get_flow(
        uuid.uuid4(),
        tenant_id=uuid.uuid4(),
        agent_prompt=agent_prompt,
        resolve_agent=False,
        support_profile=profile,
    )
    assert spec is not None
    client = _RecordingClient(replies)
    llm = build_llm(
        LlmProvider.OPENAI_COMPAT,
        project_id="",
        location="",
        credentials_path=None,
        vertex_model="",
        thinking_budget=0,
        api_key="test",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        model="gemini-2.5-flash",
    )
    llm._client = client  # only the network boundary is replaced
    pair = LLMContextAggregatorPair(LLMContext())

    async def no_records():
        return []

    worker = PipelineWorker(
        Pipeline(
            [
                pair.user(),
                OpeningTurnContext(),
                VoiceEvidenceContext(tenant_id="t", language="he", load_records=no_records),
                llm,
                pair.assistant(),
            ]
        ),
        params=PipelineParams(),
    )
    manager = FlowManager(worker=worker, llm=llm, context_aggregator=pair)
    run = asyncio.create_task(WorkerRunner(handle_sigint=False).run(worker))
    await asyncio.sleep(0.1)
    await manager.initialize(initial_node_from_spec(spec))
    await _settle(client, 1)
    for text in caller_turns:
        before = len(client.requests)
        await worker.queue_frame(
            LLMMessagesAppendFrame(messages=[{"role": "user", "content": text}], run_llm=True)
        )
        await _settle(client, before + 1)
    await worker.queue_frame(EndFrame())
    await asyncio.wait_for(run, 5)
    return client.requests


async def _settle(client, count: int) -> None:
    """Wait for at least `count` requests, then for any follow-up (tool) to finish."""
    for _ in range(250):
        if len(client.requests) >= count:
            seen = len(client.requests)
            await asyncio.sleep(0.25)
            if len(client.requests) == seen:
                return
            continue
        await asyncio.sleep(0.02)
    raise AssertionError(f"expected {count} provider requests, saw {len(client.requests)}")


def _system_messages(request: list[dict]) -> list[str]:
    return [m["content"] for m in request if m["role"] in {"system", "developer"}]


TOOL = {
    "index": 0,
    "id": "call-1",
    "type": "function",
    "function": {"name": "billing_question", "arguments": "{}"},
}


@pytest.mark.asyncio
async def test_every_request_of_two_concurrent_tenants_carries_only_its_own_identity():
    a, b = await asyncio.gather(
        _call(
            TENANT_A,
            "את נועה, נציגת התמיכה של קו אור. מחיר חבילה: 99 ₪.",
            [["<lang:he>שלום, כאן נועה מקו אור."], [TOOL], ["<lang:he>99 שקלים."]],
            ["הכרומקאסט של גוגל לא מתחבר, אתם מגוגל?", "כמה עולה החבילה?"],
        ),
        _call(
            TENANT_B,
            "You are the reception assistant for Beta Dental Clinic.",
            [["<lang:en>Hello, Beta Dental Clinic."]],
            ["Who am I speaking with?"],
        ),
    )

    assert len(a) >= 4  # greeting, turn, post-transition, turn
    for requests, own, other, own_prompt in (
        (a, "קו אור תקשורת", "Beta Dental Clinic", "את נועה, נציגת התמיכה של קו אור"),
        (b, "Beta Dental Clinic", "קו אור תקשורת", "reception assistant for Beta Dental"),
    ):
        for request in requests:
            instructions = _system_messages(request)
            # The endpoint keeps only the last instruction message; there must
            # be exactly one, first, holding identity AND the CRM agent role.
            assert len(instructions) == 1
            assert request[0]["role"] == "system"
            assert own in instructions[0] and own_prompt in instructions[0]
            assert other not in json.dumps(request, ensure_ascii=False)
            # Retained demo roles never outrank the published agent.
            assert "demo assistant for Or-On" not in instructions[0]

    # The node transition keeps identity and binds the legacy node role inside it.
    after_transition = a[2][0]["content"]
    assert (
        after_transition.index("קו אור תקשורת")
        < after_transition.index("LEGACY NODE ROLE")
        < after_transition.index("Final node identity binding")
    )

    # The opener instruction applies to the greeting only.
    assert OPENING_TURN_PREFIX in a[0][0]["content"]
    assert all(OPENING_TURN_PREFIX not in request[0]["content"] for request in a[1:])
    # The caller's words reach the provider unchanged and last among user turns.
    user_turns = [m["content"] for m in a[1] if m["role"] == "user"]
    assert user_turns[-1] == "הכרומקאסט של גוגל לא מתחבר, אתם מגוגל?"


@pytest.mark.asyncio
async def test_binding_failure_recovery_keeps_the_compiled_tenant_role():
    requests = await _call(
        TENANT_A,
        "את נועה, נציגת התמיכה של קו אור.",
        [["<lang:he>שלום."]],
        ["מי אתם?"],
        broken_handler=True,
    )

    for request in requests:
        instructions = _system_messages(request)
        assert len(instructions) == 1
        assert "קו אור תקשורת" in instructions[0]
        assert "את נועה, נציגת התמיכה של קו אור." in instructions[0]
