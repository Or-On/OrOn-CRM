"""Opt-in provider eval for the live-call repetition regression."""

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
    history: list[dict[str, str]]
    latest_caller_text: str


CASES = [
    Case(
        "continue-existing-issue",
        [],
        "אני רוצה להמשיך לדבר על הבעיה בממיר של יס.",
    ),
    Case(
        "challenge-filler",
        [{"role": "assistant", "content": "תודה על השיתוף."}],
        "מה השיתוף?",
    ),
    Case(
        "ask-next-step",
        [
            {"role": "assistant", "content": "תודה על השיתוף."},
            {"role": "user", "content": "מה השיתוף?"},
            {"role": "assistant", "content": "תודה על השיתוף."},
        ],
        "אוקיי, מה הלאה?",
    ),
]


def _endpoint() -> tuple[str, str, str] | None:
    base_url = os.environ.get("ORON_LLM_BASE_URL", "")
    model = os.environ.get("ORON_LLM_MODEL", "")
    api_key = os.environ.get("LLM_API_KEY", "")
    return (base_url, model, api_key) if base_url and model and api_key else None


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.name)
def test_provider_advances_support_instead_of_acknowledging(case: Case):
    endpoint = _endpoint()
    if endpoint is None:
        pytest.skip("set ORON_LLM_BASE_URL, ORON_LLM_MODEL and LLM_API_KEY")
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
        "temperature": 0.1,
        "max_tokens": 256,
    }
    if effort := os.environ.get("ORON_LLM_REASONING_EFFORT"):
        request["reasoning_effort"] = effort
    response = httpx.post(
        f"{base_url.rstrip('/')}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json=request,
        timeout=90,
    )
    response.raise_for_status()
    raw = response.json()["choices"][0]["message"]["content"]
    parsed = json.loads(raw)
    assert parsed != {"kind": "conversation", "intent": "acknowledge"}
    reply = render_reply(raw, [], "he", latest_caller_text=case.latest_caller_text)
    assert reply.decision == "diagnostic_question"
    assert reply.text != "תודה על השיתוף."
