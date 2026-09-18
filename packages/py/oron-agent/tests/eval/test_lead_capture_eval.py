"""Opt-in provider eval for lead capture: does the model use the tools well?

Set ``ORON_RUN_PROVIDER_EVALS=true`` to permit this module to discover provider
credentials; deployment LLM variables alone never enable a paid evaluation, and
authorization to spend on a provider is separate from holding its key.

The scenarios come from ``db/contracts/lead-capture-scenarios.v1.json`` — the
same corpus the deterministic suites replay. There the tool calls are stated,
so the durable behaviour is proven without a model; here only the caller's
words are given and the model chooses the calls, so what is measured is model
behaviour. The store below is in memory on purpose: durability belongs to
``db/tests/postgres/test_lead_scenario_corpus.py``, not to a paid run.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx
import pytest
from oron_agent.config import load_settings
from oron_agent.lead_capture import (
    AcceptedTurns,
    VoiceLeadTools,
    parse_lead_field_schema,
)

CORPUS = json.loads(
    (
        Path(__file__).resolve().parents[5] / "db" / "contracts" / "lead-capture-scenarios.v1.json"
    ).read_text(encoding="utf-8")
)
CASES = [scenario for scenario in CORPUS["scenarios"] if scenario.get("providerEval")]
FULL_CAPABILITIES = ["lead.read", "lead.write", "lead.finalize", "lead.follow_up"]
LEAD_ID = "55555555-5555-4555-8555-555555555555"


class EvalStore:
    """The durable outcome of ``platform.lead_*``, without a database.

    It keeps only what the eval reads back: one lead per enquiry, a later value
    supersedes an earlier one, and every committed write returns a receipt.
    """

    def __init__(self) -> None:
        self.lead: dict[str, Any] = {
            "id": LEAD_ID,
            "status": "new",
            "revision": 1,
            "reference": "LD-55555555",
        }
        self.fields: dict[str, dict[str, Any]] = {}
        self.receipts: dict[str, dict[str, Any]] = {}
        self.writes = 0

    def _receipt(self, operation_key: str, changed: list[str]) -> dict[str, Any]:
        self.lead["revision"] += 1
        receipt = {
            "leadId": self.lead["id"],
            "reference": self.lead["reference"],
            "revision": self.lead["revision"],
            "status": "committed",
            "operationKey": operation_key,
            "changed": changed,
        }
        self.receipts[operation_key] = receipt
        return receipt

    def _replay(self, operation_key: str) -> dict[str, Any] | None:
        recorded = self.receipts.get(operation_key)
        return None if recorded is None else {**recorded, "status": "replayed"}

    async def capture_state(self, lead_id: str | None) -> dict[str, Any] | None:
        if not self.fields and self.lead["status"] == "new":
            return None
        return {"lead": dict(self.lead), "fields": list(self.fields.values()), "schema": None}

    async def ensure(self, operation_key: str) -> dict[str, Any]:
        replayed = self._replay(operation_key)
        if replayed is not None:
            return {"receipt": replayed, "created": False}
        return {"receipt": self._receipt(operation_key, []), "created": True}

    async def save_fields(
        self, lead_id: str, operation_key: str, observations: list[dict[str, Any]]
    ) -> dict[str, Any]:
        replayed = self._replay(operation_key)
        if replayed is not None:
            return {"receipt": replayed, "rejected": []}
        for observation in observations:
            self.fields[observation["key"]] = dict(observation)
        self.writes += 1
        self.lead["status"] = "collecting"
        changed = [observation["key"] for observation in observations]
        return {"receipt": self._receipt(operation_key, changed), "rejected": []}

    async def finalize(
        self, lead_id: str, operation_key: str, summary: str, next_action: str | None
    ) -> dict[str, Any]:
        replayed = self._replay(operation_key)
        if replayed is not None:
            return {"receipt": replayed}
        self.lead.update(status="ready_for_review", summary=summary, nextAction=next_action)
        return {"receipt": self._receipt(operation_key, ["status", "summary"])}

    async def follow_up(
        self, lead_id: str, operation_key: str, note: str, due_at: str | None
    ) -> dict[str, Any]:
        replayed = self._replay(operation_key)
        if replayed is not None:
            return {"receipt": replayed}
        self.lead["nextAction"] = note
        return {"receipt": self._receipt(operation_key, ["nextAction"])}

    async def operation_receipt(self, operation_key: str) -> dict[str, Any] | None:
        return self._replay(operation_key)


def _endpoint() -> tuple[str, str, str] | None:
    if os.environ.get("ORON_RUN_PROVIDER_EVALS", "").strip().lower() != "true":
        return None
    settings = load_settings()
    base_url = (
        os.environ.get("ORON_LLM_BASE_URL")
        or os.environ.get("LLM_BASE_URL")
        or settings.llm_base_url
    )
    model = os.environ.get("ORON_LLM_MODEL") or os.environ.get("LLM_MODEL") or settings.llm_model
    api_key = os.environ.get("LLM_API_KEY") or settings.llm_api_key.get_secret_value()
    return (base_url, model, api_key) if base_url and model and api_key else None


def _build_tools(scenario: dict[str, Any]) -> tuple[EvalStore, AcceptedTurns, VoiceLeadTools]:
    store = EvalStore()
    turns = AcceptedTurns()
    tools = VoiceLeadTools(
        store=store,
        schema=parse_lead_field_schema(CORPUS["schemas"][scenario["schema"]]),
        capabilities=scenario.get("capabilities", FULL_CAPABILITIES),
        interaction_key=f"eval-{scenario['id']}",
        turns=turns,
    )
    return store, turns, tools


def _tool_payload(tools: VoiceLeadTools) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": descriptor.name,
                "description": descriptor.description,
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": descriptor.properties,
                    "required": descriptor.required,
                },
            },
        }
        for descriptor in tools.descriptors
    ]


def _system_prompt(scenario: dict[str, Any]) -> str:
    questions = "\n".join(
        f"- {field['key']} ({field['label']}){'' if field.get('required') else ' — optional'}"
        for field in CORPUS["schemas"][scenario["schema"]]
    )
    language = "Hebrew" if scenario["locale"] == "he" else "English"
    return (
        f"You are a voice assistant taking an enquiry in {language}. Record what the caller "
        "actually says using the supplied tools, one call per caller turn, and never invent an "
        "answer or ask for an identity number. A refusal is an answer: record it as declined. "
        "Only say something was saved after a tool returns a receipt.\n"
        f"The questions this tenant configured are:\n{questions}"
    )


def _reply(endpoint: tuple[str, str, str], messages: list[dict], tools: list[dict]) -> dict:
    base_url, model, api_key = endpoint
    request: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "temperature": float(os.environ.get("LLM_TEMPERATURE", "0.2")),
        "max_tokens": int(os.environ.get("LLM_MAX_TOKENS", "512")),
    }
    if effort := (
        os.environ.get("ORON_LLM_REASONING_EFFORT") or os.environ.get("LLM_REASONING_EFFORT")
    ):
        request["reasoning_effort"] = effort
    response = httpx.post(
        f"{base_url.rstrip('/')}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json=request,
        timeout=120,
    )
    response.raise_for_status()
    return response.json()["choices"][0]["message"]


@pytest.mark.parametrize("scenario", CASES, ids=lambda scenario: scenario["id"])
async def test_provider_records_what_the_caller_said(scenario: dict[str, Any]) -> None:
    endpoint = _endpoint()
    if endpoint is None:
        pytest.skip(
            "set ORON_RUN_PROVIDER_EVALS=true plus LLM_BASE_URL, LLM_MODEL and LLM_API_KEY "
            "(a provider-backed run needs authorization of its own, not only credentials)"
        )
    store, turns, tools = _build_tools(scenario)
    payload = _tool_payload(tools)
    messages: list[dict[str, Any]] = [{"role": "system", "content": _system_prompt(scenario)}]
    for turn in scenario["turns"]:
        turns.accept()
        messages.append({"role": "user", "content": turn["caller"]})
        for _ in range(3):
            message = _reply(endpoint, messages, payload)
            messages.append(message)
            requested = message.get("tool_calls") or []
            if not requested:
                break
            for call in requested:
                arguments = json.loads(call["function"]["arguments"] or "{}")
                result = await tools.run(call["function"]["name"], arguments)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call["id"],
                        "content": json.dumps(result, ensure_ascii=False),
                    }
                )

    expected = scenario["expect"]
    observed = {
        key: {
            "state": value["state"],
            "value": value["normalizedValue"],
            **({"currency": value["currency"]} if value.get("currency") else {}),
            **(
                {"confirmation": value["confirmation"]}
                if value.get("confirmation") not in (None, "unconfirmed")
                else {}
            ),
        }
        for key, value in store.fields.items()
    }
    # A model may also record something else the caller volunteered, so the
    # scenario states the floor: every answer given must be in the record.
    for key, value in expected["fields"].items():
        assert observed.get(key) == value, f"{scenario['id']}: {observed}"
    assert store.lead["status"] == expected["status"], scenario["id"]
    assert turns.receipt_for_current_turn() is expected["saveClaimAllowed"], scenario["id"]


def test_the_eval_covers_both_schemas_and_both_languages() -> None:
    assert len(CASES) >= 8
    assert {scenario["schema"] for scenario in CASES} == set(CORPUS["schemas"])
    assert {scenario["locale"] for scenario in CASES} == {"he", "en"}
    for scenario in CASES:
        # Nothing here may need a fault the harness cannot produce, and the
        # model must be offered every tool the scenario expects it to use.
        assert not scenario.get("faults"), scenario["id"]
        _, _, tools = _build_tools(scenario)
        offered = {descriptor.name for descriptor in tools.descriptors}
        used = {call["tool"] for turn in scenario["turns"] for call in turn["calls"]}
        assert used <= offered, scenario["id"]


def test_provider_eval_requires_explicit_opt_in(monkeypatch) -> None:
    monkeypatch.delenv("ORON_RUN_PROVIDER_EVALS", raising=False)
    monkeypatch.setenv("LLM_BASE_URL", "https://example.invalid/v1")
    monkeypatch.setenv("LLM_MODEL", "fixture-model")
    monkeypatch.setenv("LLM_API_KEY", "fixture-key")

    assert _endpoint() is None

    monkeypatch.setenv("ORON_RUN_PROVIDER_EVALS", "false")
    assert _endpoint() is None

    monkeypatch.setenv("ORON_RUN_PROVIDER_EVALS", "true")
    assert _endpoint() == ("https://example.invalid/v1", "fixture-model", "fixture-key")
