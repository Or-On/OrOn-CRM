"""One ordered system instruction per provider request.

Measured 2026-09-18 on Google's Gemini OpenAI-compatible endpoint: any second
system/developer message made the model drop the first (tenant identity) and
answer "I am a large language model, trained by Google" (18/18 samples).
"""

import copy

import pytest
from oron_agent.context_hygiene import OpeningTurnContext
from oron_agent.flows.greeting import OPENING_TURN_PREFIX, create_greeting_node
from oron_agent.llm import LlmProvider, _SingleInstructionGeminiAdapter, build_llm
from oron_agent.provider_context import CALL_START_EVENT, fold_instructions
from pipecat.frames.frames import LLMContextFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.tests.utils import run_test

ROLE = "Tenant identity: you represent Kav Or Support."
TASK = "Help with TV and internet."
POLICY = "VOICE EVIDENCE AND ACTION SAFETY POLICY v3. Answer the latest turn."


def _compat_llm():
    return build_llm(
        LlmProvider.OPENAI_COMPAT,
        project_id="p",
        location="global",
        credentials_path=None,
        vertex_model="unused",
        thinking_budget=0,
        api_key="key",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        model="gemini-2.5-flash",
    )


def _conversation():
    return [
        {"role": "system", "content": ROLE},
        {"role": "system", "content": TASK},
        {"role": "assistant", "content": "שלום, כאן קו אור."},
        {"role": "user", "content": "הכרומקאסט של גוגל לא מתחבר"},
        {
            "role": "assistant",
            "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "go", "arguments": "{}"}}
            ],
        },
        {"role": "tool", "content": '{"status":"running"}', "tool_call_id": "c1"},
        {"role": "developer", "content": "Tool c1 finished."},
        {"role": "system", "content": POLICY},
    ]


def test_fold_keeps_every_instruction_in_order_and_the_conversation_untouched():
    messages = _conversation()
    instruction, conversation = fold_instructions(messages)

    assert instruction == "\n\n".join([ROLE, TASK, "Tool c1 finished.", POLICY])
    assert conversation == [messages[2], messages[3], messages[4], messages[5]]


def test_fold_places_the_service_instruction_first():
    instruction, _ = fold_instructions([{"role": "system", "content": TASK}], ROLE)

    assert instruction is not None and instruction.startswith(ROLE)


def test_fold_keeps_a_repeated_update_last_for_precedence():
    male, female = "CALLER ADDRESS UPDATE: male", "CALLER ADDRESS UPDATE: female"
    instruction, _ = fold_instructions(
        [
            {"role": "system", "content": male},
            {"role": "system", "content": female},
            {"role": "system", "content": male},
            {"role": "user", "content": "hi"},
        ]
    )

    assert instruction is not None and instruction.rstrip().endswith(male)


def test_fold_supplies_a_non_customer_event_when_no_conversation_exists():
    instruction, conversation = fold_instructions([{"role": "system", "content": TASK}], ROLE)

    assert instruction == f"{ROLE}\n\n{TASK}"
    assert conversation == [{"role": "user", "content": CALL_START_EVENT}]


def test_compat_request_has_exactly_one_leading_system_message():
    messages = _conversation()
    snapshot = copy.deepcopy(messages)

    params = _compat_llm().build_chat_completion_params({"messages": messages})

    roles = [message["role"] for message in params["messages"]]
    assert roles == ["system", "assistant", "user", "assistant", "tool"]
    assert params["messages"][0]["content"].startswith(ROLE)
    assert POLICY in params["messages"][0]["content"]
    assert params["messages"][2]["content"] == "הכרומקאסט של גוגל לא מתחבר"
    assert messages == snapshot  # the shared LLM context is never mutated


def test_gemini_adapter_keeps_the_node_task_and_never_turns_policy_into_caller_speech():
    context = LLMContext(messages=_conversation()[1:])  # role comes from settings

    params = _SingleInstructionGeminiAdapter().get_llm_invocation_params(
        context, system_instruction=ROLE
    )

    assert params["system_instruction"] == "\n\n".join([ROLE, TASK, "Tool c1 finished.", POLICY])
    spoken_by_user = [
        part.text
        for content in params["messages"]
        if content.role == "user"
        for part in content.parts or []
        if part.text
    ]
    assert spoken_by_user == ["הכרומקאסט של גוגל לא מתחבר"]


def _opener_messages():
    return [
        {"role": "system", "content": TASK},
        *create_greeting_node("he")["task_messages"],
    ]


@pytest.mark.asyncio
async def test_opening_instruction_is_retired_after_a_delivered_greeting():
    context = LLMContext(
        messages=[
            *_opener_messages(),
            {"role": "assistant", "content": "שלום, כאן קו אור. במה אפשר לעזור?"},
            {"role": "user", "content": "כמה עולה החבילה?"},
        ]
    )

    await run_test(OpeningTurnContext(), frames_to_send=[LLMContextFrame(context=context)])

    contents = [str(message.get("content")) for message in context.get_messages()]
    assert not any(content.startswith(OPENING_TURN_PREFIX) for content in contents)
    assert TASK in contents and "כמה עולה החבילה?" in contents


@pytest.mark.asyncio
async def test_opening_instruction_survives_until_a_greeting_was_delivered():
    context = LLMContext(
        messages=[*_opener_messages(), {"role": "user", "content": "הלו? כמה עולה החבילה?"}]
    )

    await run_test(OpeningTurnContext(), frames_to_send=[LLMContextFrame(context=context)])

    assert any(
        str(message.get("content")).startswith(OPENING_TURN_PREFIX)
        for message in context.get_messages()
    )
