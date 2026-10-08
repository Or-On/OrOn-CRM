"""Opt-in provider evaluation for neutral support-flow routing.

This is deliberately based on the compiled ``EXAMPLE_HE`` and ``EXAMPLE_EN``
support flows. The
former provider harness used a political-persuasion fixture; Gemini could
legitimately suppress that request with zero completion tokens, which measured
content policy rather than the CRM's function-calling contract.

The endpoint remains explicit and paid. It accepts the deployment variable
names, with ``ORON_LLM_*`` endpoint overrides for a deliberate comparison run::

    LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai \
    LLM_MODEL=gemini-2.5-flash \
    LLM_REASONING_EFFORT=none \
    LLM_API_KEY=... \
    ORON_RUN_PROVIDER_EVALS=true \
    uv run pytest packages/py/oron-flows/tests/eval/test_exit_eval.py -s

Without that explicit opt-in, or with an unset endpoint or key, the paid test
reports ``unavailable``. Ordinary CI never makes a provider request.
"""

from __future__ import annotations

import os
from collections import Counter
from dataclasses import dataclass

import httpx
import pytest
from oron_agent.grounding import grounding_instruction, render_reply
from oron_agent.model_parameters import compatible_parameters
from oron_agent.provider_context import fold_instructions
from oron_flows.compose import expand
from oron_flows.node import FlowNode
from oron_flows.seeds import EXAMPLE_EN, EXAMPLE_HE
from pydantic import BaseModel

RUNS = 3


def support_node(locale: str = "he") -> FlowNode:
    """Return the actual compiled conversational support node."""

    composition = EXAMPLE_HE if locale == "he" else EXAMPLE_EN
    spec = expand(composition)
    node = next(node for node in spec.nodes if node.name == "collect_reason")
    return node.model_copy(update={"role_message": node.role_message or spec.role_message})


@dataclass(frozen=True)
class Endpoint:
    base_url: str
    model: str
    api_key: str
    reasoning_effort: str | None
    temperature: float
    max_tokens: int


def request(endpoint: Endpoint, case: ExitCase) -> dict:
    """Build the same messages, tools, and quality knobs used by DEV voice."""

    node = support_node(case.locale)
    messages = [
        {"role": message.role.value, "content": message.content} for message in node.task_messages
    ]
    if node.role_message:
        messages.insert(0, {"role": "system", "content": node.role_message})
    messages += [{"role": role, "content": text} for role, text in case.history]
    messages.append({"role": "user", "content": case.last_turn})
    messages.append({"role": "system", "content": grounding_instruction([], case.locale)})
    # Use the production provider serializer: Gemini's compatibility endpoint
    # otherwise discards every instruction except the final evidence policy,
    # making this harness lose the authored objective and tenant identity.
    instruction, conversation = fold_instructions(messages)
    messages = [{"role": "system", "content": instruction}, *conversation]

    tools = [
        {
            "type": "function",
            "function": {
                "name": function.name,
                "description": function.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        parameter.name: {
                            "type": parameter.type.value,
                            "description": parameter.description,
                        }
                        for parameter in function.parameters
                    },
                    "required": [
                        parameter.name for parameter in function.parameters if parameter.required
                    ],
                },
            },
        }
        for function in node.functions
    ]
    payload: dict[str, object] = {
        "model": endpoint.model,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        **compatible_parameters(
            endpoint.base_url, endpoint.model, endpoint.temperature, endpoint.reasoning_effort
        ),
        "max_tokens": endpoint.max_tokens,
    }
    return payload


def exit_function_names(locale: str) -> set[str]:
    return {function.name for function in support_node(locale).functions if function.routes}


class ExitCase(BaseModel):
    label: str
    locale: str
    history: list[tuple[str, str]]
    last_turn: str
    expect: str | None


CASES = [
    ExitCase(
        label="he objective complete",
        locale="he",
        history=[
            ("assistant", "שלום, הגעתם למוקד. איך אפשר לעזור?"),
            ("user", "הממיר לא מצליח להתחבר לאינטרנט."),
            ("assistant", "הבנתי שהממיר לא מתחבר לאינטרנט. זה תיאור נכון?"),
        ],
        last_turn="כן, הבנת נכון.",
        expect="collect_reason_done",
    ),
    ExitCase(
        label="he explicit stop",
        locale="he",
        history=[
            ("assistant", "שלום, הגעתם למוקד. איך אפשר לעזור?"),
            ("user", "אני מתקשר בגלל תקלה בממיר."),
            ("assistant", "מה בדיוק מופיע על המסך כרגע?"),
        ],
        last_turn="תפסיקי בבקשה את השיחה עכשיו.",
        expect="global_caller_goodbye",
    ),
    ExitCase(
        label="he still engaged",
        locale="he",
        history=[
            ("assistant", "שלום, הגעתם למוקד. איך אפשר לעזור?"),
            ("user", "אני מתקשר בגלל תקלה בממיר."),
            ("assistant", "מה בדיוק מופיע על המסך כרגע?"),
        ],
        last_turn="עוד לא הסברתי את כל הבעיה; מה תרצי לדעת קודם?",
        expect=None,
    ),
    ExitCase(
        label="en objective complete",
        locale="en",
        history=[
            ("assistant", "Hello, you've reached support. How can I help?"),
            ("user", "My set-top box cannot connect to the internet."),
            (
                "assistant",
                "I understand that the set-top box cannot connect to the internet. Is that right?",
            ),
        ],
        last_turn="Yes, that's exactly right.",
        expect="collect_reason_done",
    ),
    ExitCase(
        label="en goodbye",
        locale="en",
        history=[
            ("assistant", "Hello, you've reached support. How can I help?"),
            ("user", "I was calling about a connection issue."),
            ("assistant", "What happens when you try to connect?"),
        ],
        last_turn="Thanks, that's all. Goodbye.",
        expect="global_caller_goodbye",
    ),
    ExitCase(
        label="en still engaged",
        locale="en",
        history=[
            ("assistant", "Hello, you've reached support. How can I help?"),
            ("user", "I am calling about a problem with my set-top box."),
            ("assistant", "What exactly appears on the screen?"),
        ],
        last_turn="I haven't explained the whole issue yet. What do you need to know first?",
        expect=None,
    ),
]


def _endpoint() -> Endpoint | None:
    if os.environ.get("ORON_RUN_PROVIDER_EVALS", "").strip().lower() != "true":
        return None
    base_url = os.environ.get("ORON_LLM_BASE_URL") or os.environ.get("LLM_BASE_URL", "")
    model = os.environ.get("ORON_LLM_MODEL") or os.environ.get("LLM_MODEL", "")
    api_key = os.environ.get("LLM_API_KEY", "")
    if not all((base_url, model, api_key)):
        return None
    return Endpoint(
        base_url=base_url,
        model=model,
        api_key=api_key,
        reasoning_effort=os.environ.get("ORON_LLM_REASONING_EFFORT")
        or os.environ.get("LLM_REASONING_EFFORT"),
        temperature=float(os.environ.get("LLM_TEMPERATURE", "0.4")),
        max_tokens=int(os.environ.get("LLM_MAX_TOKENS", "256")),
    )


@dataclass(frozen=True)
class Outcome:
    function: str | None
    content: str | None
    finish_reason: str | None


def _outcome(client: httpx.Client, endpoint: Endpoint, case: ExitCase) -> Outcome:
    response = client.post(
        f"{endpoint.base_url.rstrip('/')}/chat/completions",
        headers={"Authorization": f"Bearer {endpoint.api_key}"},
        json=request(endpoint, case),
        timeout=90.0,
    )
    response.raise_for_status()
    choice = response.json()["choices"][0]
    message = choice["message"]
    calls = message.get("tool_calls") or []
    return Outcome(
        function=calls[0]["function"]["name"] if calls else None,
        content=message.get("content"),
        finish_reason=choice.get("finish_reason"),
    )


def test_neutral_support_flow_routes_completion_and_exit_but_not_an_active_caller():
    endpoint = _endpoint()
    if endpoint is None:
        pytest.skip(
            "unavailable — set ORON_RUN_PROVIDER_EVALS=true plus LLM_BASE_URL, "
            "LLM_MODEL and LLM_API_KEY "
            "(ORON_LLM_BASE_URL/MODEL may override the endpoint)"
        )

    exits = {locale: exit_function_names(locale) for locale in ("he", "en")}
    print(f"\n[exit-eval] {endpoint.model} — neutral support exits: {exits}")

    failures: list[str] = []
    with httpx.Client() as client:
        for case in CASES:
            outcomes = [_outcome(client, endpoint, case) for _ in range(RUNS)]
            chosen = Counter(outcome.function for outcome in outcomes)
            routed = chosen[case.expect]
            if case.expect is None:
                useful = sum(
                    render_reply(
                        outcome.content or "",
                        [],
                        case.locale,
                    ).decision
                    in {
                        # Current production preserves safe natural speech;
                        # it no longer classifies it into canned intent labels.
                        "natural_conversation",
                    }
                    and bool(outcome.content and outcome.content.strip())
                    and outcome.content not in {"תודה על השיתוף.", "Thank you for sharing."}
                    for outcome in outcomes
                    if outcome.function is None and outcome.finish_reason == "stop"
                )
                passed = routed == RUNS and useful == RUNS
            else:
                passed = routed == RUNS and all(
                    outcome.finish_reason in {"stop", "tool_calls"} for outcome in outcomes
                )
            picked = ", ".join(f"{name or 'text'}x{count}" for name, count in chosen.items())
            print(f"  {case.label:18} [{picked}]  {'ok' if passed else 'FAIL'}")
            if not passed:
                failures.append(
                    f"{case.label}: wanted {case.expect or 'useful text'} x{RUNS}, got {picked}"
                )

    assert not failures, "; ".join(failures)


def test_neutral_support_exit_conditions_do_not_overlap():
    for locale in ("he", "en"):
        node = support_node(locale)
        goodbye = next(
            function for function in node.functions if function.name == "global_caller_goodbye"
        )
        done = next(
            function for function in node.functions if function.name == "collect_reason_done"
        )

        assert (
            "goodbye" in goodbye.description.lower()
            or "end the call" in goodbye.description.lower()
        )
        assert "objective has been accomplished" in done.description.lower()
        assert goodbye.routes != done.routes


def test_live_eval_inherits_production_quality_knobs(monkeypatch):
    monkeypatch.setenv("ORON_RUN_PROVIDER_EVALS", "true")
    monkeypatch.delenv("ORON_LLM_BASE_URL", raising=False)
    monkeypatch.delenv("ORON_LLM_MODEL", raising=False)
    monkeypatch.delenv("ORON_LLM_REASONING_EFFORT", raising=False)
    monkeypatch.setenv("LLM_BASE_URL", "https://example.invalid/v1")
    monkeypatch.setenv("LLM_MODEL", "fixture-model")
    monkeypatch.setenv("LLM_API_KEY", "fixture-key")
    monkeypatch.setenv("LLM_REASONING_EFFORT", "none")
    monkeypatch.setenv("LLM_TEMPERATURE", "0.25")
    monkeypatch.setenv("LLM_MAX_TOKENS", "192")

    endpoint = _endpoint()

    assert endpoint is not None
    assert endpoint.base_url == "https://example.invalid/v1"
    assert endpoint.model == "fixture-model"
    assert endpoint.reasoning_effort == "none"
    assert endpoint.temperature == 0.25
    assert endpoint.max_tokens == 192


def test_provider_eval_preserves_tenant_role_and_objective_in_one_instruction():
    endpoint = Endpoint("https://example.invalid/v1", "fixture", "fixture", None, 0.4, 256)
    payload = request(endpoint, CASES[3])
    messages = payload["messages"]
    instructions = [message for message in messages if message["role"] == "system"]

    assert len(instructions) == 1
    assert "the support line" in instructions[0]["content"]
    assert "MUST call collect_reason_done" in instructions[0]["content"]
    assert "VOICE EVIDENCE AND ACTION SAFETY POLICY" in instructions[0]["content"]
    assert messages[-1] == {"role": "user", "content": CASES[3].last_turn}


def test_provider_eval_ignores_config_without_explicit_opt_in(monkeypatch):
    monkeypatch.delenv("ORON_RUN_PROVIDER_EVALS", raising=False)
    monkeypatch.setenv("LLM_BASE_URL", "https://example.invalid/v1")
    monkeypatch.setenv("LLM_MODEL", "fixture-model")
    monkeypatch.setenv("LLM_API_KEY", "fixture-key")

    assert _endpoint() is None

    monkeypatch.setenv("ORON_RUN_PROVIDER_EVALS", "0")
    assert _endpoint() is None
