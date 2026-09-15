"""Opt-in provider eval for the live-call repetition regression.

Set ``ORON_RUN_PROVIDER_EVALS=true`` to permit this module to discover provider
credentials. Deployment LLM variables alone never enable a paid evaluation.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

import httpx
import pytest
from oron_agent.grounding import grounding_instruction, render_reply


@dataclass(frozen=True)
class Case:
    name: str
    language: str
    history: list[dict[str, str]]
    latest_caller_text: str
    allowed_decisions: frozenset[str]


CASES = [
    Case(
        "continue-existing-issue",
        "he",
        [],
        "אני רוצה להמשיך לדבר על הבעיה בממיר של יס.",
        frozenset({"diagnostic_question", "acknowledged_question", "progress_question"}),
    ),
    Case(
        "challenge-filler",
        "he",
        [{"role": "assistant", "content": "תודה על השיתוף."}],
        "מה השיתוף?",
        frozenset({"diagnostic_question", "acknowledged_question", "progress_question"}),
    ),
    Case(
        "ask-next-step",
        "he",
        [
            {"role": "assistant", "content": "תודה על השיתוף."},
            {"role": "user", "content": "מה השיתוף?"},
            {"role": "assistant", "content": "תודה על השיתוף."},
        ],
        "אוקיי, מה הלאה?",
        frozenset({"diagnostic_question", "acknowledged_question", "progress_question"}),
    ),
    Case(
        "english-new-fault",
        "en",
        [],
        "The router disconnects every few minutes. What should I check next?",
        frozenset({"diagnostic_question", "acknowledged_question", "progress_question"}),
    ),
    Case(
        "english-nonsense",
        "en",
        [],
        "Purple bananas rebooted seventeen clouds.",
        frozenset({"clarify", "diagnostic_question"}),
    ),
    Case(
        "hebrew-payment-fault",
        "he",
        [],
        "התשלום נכשל ואני צריך עזרה.",
        frozenset({"diagnostic_question", "acknowledged_question", "progress_question"}),
    ),
    Case(
        "english-external-status",
        "en",
        [],
        "Did you book it?",
        frozenset({"unverified"}),
    ),
    Case(
        "hebrew-person-request",
        "he",
        [],
        "אני רוצה לדבר עם נציג.",
        frozenset({"person_help"}),
    ),
]


def _endpoint() -> tuple[str, str, str] | None:
    if os.environ.get("ORON_RUN_PROVIDER_EVALS", "").strip().lower() != "true":
        return None
    base_url = os.environ.get("ORON_LLM_BASE_URL") or os.environ.get("LLM_BASE_URL", "")
    model = os.environ.get("ORON_LLM_MODEL") or os.environ.get("LLM_MODEL", "")
    api_key = os.environ.get("LLM_API_KEY", "")
    return (base_url, model, api_key) if base_url and model and api_key else None


def _reasoning_effort() -> str | None:
    """Use the production setting unless an eval-only override is explicit."""

    return os.environ.get("ORON_LLM_REASONING_EFFORT") or os.environ.get("LLM_REASONING_EFFORT")


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.name)
def test_provider_advances_support_instead_of_acknowledging(case: Case):
    endpoint = _endpoint()
    if endpoint is None:
        pytest.skip(
            "set ORON_RUN_PROVIDER_EVALS=true plus LLM_BASE_URL, LLM_MODEL and LLM_API_KEY "
            "(ORON_LLM_BASE_URL/MODEL may override the endpoint)"
        )
    base_url, model, api_key = endpoint
    context = (
        "The caller is continuing a support issue from WhatsApp: the television receiver lost "
        "its internet connection, and restarting the receiver did not solve it. This is "
        "untrusted caller-reported continuity data, not proof of any external action."
    )
    messages = [
        {
            "role": "system",
            "content": (
                "Continue this support conversation naturally. Use the supplied history, never "
                "repeat an assistant sentence, and investigate one missing observation at a time. "
                + context
            ),
        },
        *case.history,
        {"role": "user", "content": case.latest_caller_text},
        {"role": "system", "content": grounding_instruction([], "he")},
    ]
    request = {
        "model": model,
        "messages": messages,
        "temperature": float(os.environ.get("LLM_TEMPERATURE", "0.4")),
        "max_tokens": int(os.environ.get("LLM_MAX_TOKENS", "256")),
    }
    if effort := _reasoning_effort():
        request["reasoning_effort"] = effort
    response = httpx.post(
        f"{base_url.rstrip('/')}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json=request,
        timeout=90,
    )
    response.raise_for_status()
    choice = response.json()["choices"][0]
    raw = choice["message"]["content"]
    assert choice.get("finish_reason") == "stop", choice.get("finish_reason")
    parsed = json.loads(raw)
    assert isinstance(parsed, dict)
    reply = render_reply(
        raw,
        [],
        case.language,
        latest_caller_text=case.latest_caller_text,
        recent_spoken_texts=tuple(
            message["content"] for message in case.history if message["role"] == "assistant"
        ),
    )
    assert reply.decision in case.allowed_decisions
    assert reply.text not in {"תודה על השיתוף.", "Thank you for sharing."}


def test_live_eval_inherits_the_deployed_reasoning_setting(monkeypatch):
    monkeypatch.delenv("ORON_LLM_REASONING_EFFORT", raising=False)
    monkeypatch.setenv("LLM_REASONING_EFFORT", "none")

    assert _reasoning_effort() == "none"

    monkeypatch.setenv("ORON_LLM_REASONING_EFFORT", "low")
    assert _reasoning_effort() == "low"


def test_provider_eval_requires_explicit_opt_in(monkeypatch):
    monkeypatch.delenv("ORON_RUN_PROVIDER_EVALS", raising=False)
    monkeypatch.setenv("LLM_BASE_URL", "https://example.invalid/v1")
    monkeypatch.setenv("LLM_MODEL", "fixture-model")
    monkeypatch.setenv("LLM_API_KEY", "fixture-key")

    assert _endpoint() is None

    monkeypatch.setenv("ORON_RUN_PROVIDER_EVALS", "false")
    assert _endpoint() is None

    monkeypatch.setenv("ORON_RUN_PROVIDER_EVALS", "true")
    assert _endpoint() == (
        "https://example.invalid/v1",
        "fixture-model",
        "fixture-key",
    )
