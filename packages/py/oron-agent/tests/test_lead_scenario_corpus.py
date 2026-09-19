"""Replay the behavioural corpus against a store that models the real one.

``db/contracts/lead-capture-scenarios.v1.json`` is the single description of
how lead capture must behave; ``db/tests/postgres/test_lead_scenario_corpus.py``
replays the same scenarios against the real ``platform.lead_*`` functions. This
suite adds what a database cannot be asked to do on demand: drop a connection
after the write committed, drop it before, and refuse a fenced worker. No model
and no provider is involved — the tool calls a correct agent would make are
stated by the scenario, and what is asserted is the durable outcome.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from oron_agent.lead_capture import (
    AcceptedTurns,
    LeadStoreRefusal,
    VoiceLeadTools,
    lead_completeness,
    parse_lead_field_schema,
)
from oron_agent.lead_capture_contract import CONTRACT

CORPUS = json.loads(
    (
        Path(__file__).resolve().parents[4] / "db" / "contracts" / "lead-capture-scenarios.v1.json"
    ).read_text(encoding="utf-8")
)
SCENARIOS = CORPUS["scenarios"]
FULL_CAPABILITIES = ["lead.read", "lead.write", "lead.finalize", "lead.follow_up"]
LEAD_ID = "77777777-7777-4777-8777-777777777777"


class DroppedConnection(RuntimeError):
    """Neither a refusal nor a success: the caller cannot know which."""


class CorpusStore:
    """An in-memory stand-in for the ``platform.lead_*`` functions.

    It keeps the properties the functions guarantee and the harness depends on:
    one lead per enquiry, a later value supersedes an earlier one, an operation
    key commits at most once, and a receipt exists for every committed write.
    """

    def __init__(self) -> None:
        self.lead: dict[str, Any] | None = None
        self.fields: dict[str, dict[str, Any]] = {}
        self.receipts: dict[str, dict[str, Any]] = {}
        self.writes = 0
        self.fault: str | None = None

    def _open(self) -> dict[str, Any]:
        if self.lead is None:
            self.lead = {"id": LEAD_ID, "status": "new", "revision": 1, "reference": "LD-77777777"}
        return self.lead

    def _receipt(self, operation_key: str, changed: list[str]) -> dict[str, Any]:
        lead = self._open()
        lead["revision"] += 1
        receipt = {
            "leadId": lead["id"],
            "reference": lead["reference"],
            "revision": lead["revision"],
            "status": "committed",
            "operationKey": operation_key,
            "changed": changed,
        }
        self.receipts[operation_key] = receipt
        return receipt

    def _replay(self, operation_key: str) -> dict[str, Any] | None:
        recorded = self.receipts.get(operation_key)
        return None if recorded is None else {**recorded, "status": "replayed"}

    def _interrupt(self, committed: bool) -> None:
        """Apply the scenario's injected fault to the write in progress."""

        fault, self.fault = self.fault, None
        if fault is None:
            return
        if fault.startswith("refuse:"):
            raise LeadStoreRefusal(fault.split(":", 1)[1], "the action was refused")
        if fault == "commit_then_drop" and committed:
            raise DroppedConnection(fault)
        if fault == "drop_before_commit" and not committed:
            raise DroppedConnection(fault)
        self.fault = fault

    async def capture_state(self, lead_id: str | None) -> dict[str, Any] | None:
        if self.lead is None:
            return None
        return {
            "lead": dict(self.lead),
            "fields": [dict(value) for value in self.fields.values()],
            "schema": None,
        }

    async def ensure(self, operation_key: str) -> dict[str, Any]:
        replayed = self._replay(operation_key)
        if replayed is not None:
            return {"receipt": replayed, "created": False}
        created = self.lead is None
        return {"receipt": self._receipt(operation_key, []), "created": created}

    async def save_fields(
        self, lead_id: str, operation_key: str, observations: list[dict[str, Any]]
    ) -> dict[str, Any]:
        replayed = self._replay(operation_key)
        if replayed is not None:
            return {"receipt": replayed, "rejected": []}
        self._interrupt(committed=False)
        for observation in observations:
            self.fields[observation["key"]] = dict(observation)
        self.writes += 1
        self._open()["status"] = "collecting"
        receipt = self._receipt(operation_key, [entry["key"] for entry in observations])
        self._interrupt(committed=True)
        return {"receipt": receipt, "rejected": []}

    async def finalize(
        self, lead_id: str, operation_key: str, summary: str, next_action: str | None
    ) -> dict[str, Any]:
        replayed = self._replay(operation_key)
        if replayed is not None:
            return {"receipt": replayed}
        self._interrupt(committed=False)
        lead = self._open()
        lead["status"] = "ready_for_review"
        lead["summary"] = summary
        lead["nextAction"] = next_action
        return {"receipt": self._receipt(operation_key, ["status", "summary"])}

    async def follow_up(
        self, lead_id: str, operation_key: str, note: str, due_at: str | None
    ) -> dict[str, Any]:
        replayed = self._replay(operation_key)
        if replayed is not None:
            return {"receipt": replayed}
        self._interrupt(committed=False)
        self._open()["nextAction"] = note
        return {"receipt": self._receipt(operation_key, ["nextAction"])}

    async def operation_receipt(self, operation_key: str) -> dict[str, Any] | None:
        return self._replay(operation_key)


def oversized_observations() -> list[dict[str, Any]]:
    limit = CONTRACT["tools"]["maxObservationsPerCall"]
    return [
        {"key": "company", "state": "known", "value": f"Acme {index}"} for index in range(limit + 1)
    ]


def scenario_arguments(call: dict[str, Any]) -> dict[str, Any]:
    arguments = dict(call["arguments"])
    if arguments.get("observations") == "__oversized__":
        arguments["observations"] = oversized_observations()
    return arguments


def assert_call(scenario: dict[str, Any], call: dict[str, Any], result: dict[str, Any]) -> None:
    where = f"{scenario['id']} / {call['tool']}"
    expected = call.get("expect", {})
    assert result["ok"] is expected.get("ok", True), f"{where}: {result.get('error')}"
    if "saved" in expected:
        assert result.get("saved") is expected["saved"], where
    if "code" in expected:
        assert result.get("code") == expected["code"], where
    if "field" in expected:
        # A refusal names the question it refused, so the agent can ask again.
        assert result.get("field") == expected["field"], f"{where}: {result}"
        assert expected["field"] in str(result.get("error")), f"{where}: {result}"
    if "errorContains" in expected:
        assert expected["errorContains"] in str(result.get("error")), f"{where}: {result}"
    if "missingRequired" in expected:
        assert result["missingRequired"] == expected["missingRequired"], where
    if "collectedKeys" in expected:
        collected = sorted(entry["key"] for entry in result["collected"])
        assert collected == sorted(expected["collectedKeys"]), where


def assert_outcome(
    scenario: dict[str, Any], store: CorpusStore, turns: AcceptedTurns, schema
) -> None:
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
    assert observed == expected["fields"], scenario["id"]
    status = (store.lead or {}).get("status", "new")
    assert status == expected["status"], scenario["id"]
    assert turns.receipt_for_current_turn() is expected["saveClaimAllowed"], scenario["id"]
    if "missingRequired" in expected:
        completeness = lead_completeness(schema, list(store.fields.values()))
        assert completeness["missing"] == expected["missingRequired"], scenario["id"]
    if "writes" in expected:
        assert store.writes == expected["writes"], scenario["id"]


async def replay(scenario: dict[str, Any]) -> None:
    schema = parse_lead_field_schema(CORPUS["schemas"][scenario["schema"]])
    store = CorpusStore()
    turns = AcceptedTurns()
    tools = VoiceLeadTools(
        store=store,
        schema=schema,
        capabilities=scenario.get("capabilities", FULL_CAPABILITIES),
        interaction_key=f"{scenario['id']}-1",
        turns=turns,
    )
    if "expectToolCount" in scenario:
        assert len(tools.descriptors) == scenario["expectToolCount"], scenario["id"]
    previous_revision: int | None = None
    for index, turn in enumerate(scenario["turns"], start=1):
        if turn["caller"] is not None:
            turns.accept()
        for call in turn["calls"]:
            store.fault = call.get("fault")
            result = await tools.run(call["tool"], scenario_arguments(call))
            assert_call(scenario, call, result)
            expected = call.get("expect", {})
            if expected.get("sameRevisionAsPrevious"):
                assert result["revision"] == previous_revision, scenario["id"]
            if expected.get("sourceReference"):
                stored = store.fields[call["arguments"]["observations"][0]["key"]]
                assert stored["sourceReferenceId"] == expected["sourceReference"], scenario["id"]
            previous_revision = result.get("revision", previous_revision)
        if scenario.get("continuesAfterTurn") == index:
            # The callback is a different interaction: new turns, new operation
            # keys, and the lead is found through the link, never guessed.
            turns = AcceptedTurns()
            tools = VoiceLeadTools(
                store=store,
                schema=schema,
                capabilities=scenario.get("capabilities", FULL_CAPABILITIES),
                interaction_key=f"{scenario['id']}-2",
                turns=turns,
            )
    assert_outcome(scenario, store, turns, schema)


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda scenario: scenario["id"])
def test_lead_behaviour_corpus(scenario: dict[str, Any]) -> None:
    asyncio.run(replay(scenario))


def test_the_corpus_is_large_enough_to_be_a_corpus() -> None:
    assert len(SCENARIOS) >= 30
    assert len({scenario["id"] for scenario in SCENARIOS}) == len(SCENARIOS)
    assert {scenario["schema"] for scenario in SCENARIOS} == set(CORPUS["schemas"])
    assert {scenario["locale"] for scenario in SCENARIOS} == {"he", "en"}


def test_every_scenario_states_a_durable_outcome() -> None:
    for scenario in SCENARIOS:
        expect = scenario["expect"]
        assert set(expect) <= {
            "fields",
            "missingRequired",
            "status",
            "saveClaimAllowed",
            "writes",
        }, scenario["id"]
        assert isinstance(expect["saveClaimAllowed"], bool)
        assert expect["status"] in CONTRACT["enums"]["leadStatuses"]
        for capability in scenario.get("capabilities", FULL_CAPABILITIES):
            assert capability in CONTRACT["enums"]["capabilities"]
