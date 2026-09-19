"""Voice lead tool orchestration against a recording fake of the store port.

The store fake stands in for the ``platform.lead_*`` functions only; the real
functions are exercised against PostgreSQL in the dispatcher's tests.
"""

from __future__ import annotations

import asyncio
from typing import Any

from oron_agent.lead_capture import (
    AcceptedTurns,
    LeadStoreRefusal,
    VoiceLeadTools,
    parse_lead_field_schema,
)

SCHEMA = parse_lead_field_schema(
    [
        {"key": "preferred_name", "label": "Name", "type": "text", "required": True},
        {"key": "company", "label": "Company", "type": "text", "required": True},
        {"key": "seats", "label": "Users", "type": "number", "required": False, "minimum": 1},
        {"key": "budget", "label": "Budget", "type": "currency", "required": False},
    ]
)
LEAD_ID = "55555555-5555-4555-8555-555555555555"


class FakeStore:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple]] = []
        self.fields: dict[str, dict] = {}
        self.revision = 1
        self.fail_next_save: Exception | None = None
        self.committed: dict[str, dict] = {}

    def _receipt(self, key: str, changed: list[str]) -> dict:
        self.revision += 1
        receipt = {
            "leadId": LEAD_ID,
            "reference": "LD-55555555",
            "revision": self.revision,
            "status": "committed",
            "operationKey": key,
            "changed": changed,
        }
        self.committed[key] = receipt
        return receipt

    async def capture_state(self, lead_id: str | None) -> dict | None:
        self.calls.append(("capture_state", (lead_id,)))
        if lead_id is None and not self.fields:
            return None
        return {
            "lead": {"id": LEAD_ID, "status": "collecting", "revision": self.revision},
            "fields": list(self.fields.values()),
            "schema": None,
        }

    async def ensure(self, operation_key: str) -> dict:
        self.calls.append(("ensure", (operation_key,)))
        return {"receipt": self._receipt(operation_key, []), "created": True}

    async def save_fields(self, lead_id: str, operation_key: str, observations: list) -> dict:
        self.calls.append(("save_fields", (lead_id, operation_key, observations)))
        if operation_key in self.committed:
            return {
                "receipt": {**self.committed[operation_key], "status": "replayed"},
                "rejected": [],
            }
        failure, self.fail_next_save = self.fail_next_save, None
        if isinstance(failure, LeadStoreRefusal):
            raise failure
        for observation in observations:
            self.fields[observation["key"]] = observation
        receipt = self._receipt(operation_key, [entry["key"] for entry in observations])
        if failure is not None:
            # Committed, then the connection dropped before the answer arrived.
            raise failure
        return {"receipt": receipt, "rejected": []}

    async def finalize(self, lead_id: str, operation_key: str, summary: str, next_action):
        self.calls.append(("finalize", (lead_id, operation_key, summary, next_action)))
        return {"receipt": self._receipt(operation_key, ["status", "summary"])}

    async def follow_up(self, lead_id: str, operation_key: str, note: str, due_at):
        self.calls.append(("follow_up", (lead_id, operation_key, note, due_at)))
        return {"receipt": self._receipt(operation_key, ["nextAction"])}

    async def operation_receipt(self, operation_key: str) -> dict | None:
        self.calls.append(("operation_receipt", (operation_key,)))
        receipt = self.committed.get(operation_key)
        return None if receipt is None else {**receipt, "status": "replayed"}


def tools(store: FakeStore, capabilities: list[str], turns: AcceptedTurns | None = None):
    return VoiceLeadTools(
        store=store,
        schema=SCHEMA,
        capabilities=capabilities,
        interaction_key="session-1",
        turns=turns or AcceptedTurns(),
    )


FULL = ["lead.read", "lead.write", "lead.finalize", "lead.follow_up"]


def run(coroutine) -> Any:
    return asyncio.run(coroutine)


def test_an_agent_without_lead_capability_gets_no_lead_tool() -> None:
    store = FakeStore()
    survey = tools(store, [])
    assert survey.descriptors == []
    assert survey.functions() == []
    result = run(
        survey.run("lead_save_fields", {"observations": [{"key": "company", "state": "known"}]})
    )
    # Even a direct call cannot reach the store: a customer saying "save a lead"
    # to a survey agent changes nothing.
    assert result == {"ok": False, "error": "this action is not enabled for this agent"}
    assert store.calls == []


def test_nothing_is_saved_before_the_caller_has_said_anything() -> None:
    store = FakeStore()
    result = run(
        tools(store, FULL).run(
            "lead_save_fields",
            {"observations": [{"key": "company", "state": "known", "value": "X"}]},
        )
    )
    assert result["ok"] is False
    assert store.calls == []


def test_several_answers_in_one_turn_are_saved_with_that_turn_as_evidence() -> None:
    store, turns = FakeStore(), AcceptedTurns()
    runtime = tools(store, FULL, turns)
    turns.accept()
    turn = turns.accept()
    result = run(
        runtime.run(
            "lead_save_fields",
            {
                "observations": [
                    {"key": "preferred_name", "state": "known", "value": "רוני", "confirmed": True},
                    {"key": "seats", "state": "known", "value": "1,200"},
                    {"key": "budget", "state": "declined"},
                    # A citation the call never accepted falls back to this turn.
                    {
                        "key": "company",
                        "state": "known",
                        "value": "Acme",
                        "sourceReference": "turn-99",
                    },
                ]
            },
        )
    )
    assert result["ok"] is True and result["saved"] is True
    assert result["changed"] == ["preferred_name", "seats", "budget", "company"]
    assert result["missingRequired"] == []
    saved = store.calls[-2][1][2] if store.calls[-1][0] == "capture_state" else None
    assert saved is not None
    by_key = {entry["key"]: entry for entry in saved}
    assert by_key["preferred_name"]["confirmation"] == "customer_confirmed"
    assert by_key["seats"]["normalizedValue"] == "1200"
    assert by_key["budget"] == {**by_key["budget"], "state": "declined", "rawValue": None}
    assert {entry["sourceReferenceId"] for entry in saved} == {turn}
    assert turns.receipt_for_current_turn() is True


def test_a_model_cannot_mark_its_own_extraction_as_verified_by_a_person() -> None:
    store, turns = FakeStore(), AcceptedTurns()
    turns.accept()
    run(
        tools(store, FULL, turns).run(
            "lead_save_fields",
            {
                "observations": [
                    {
                        "key": "company",
                        "state": "known",
                        "value": "Acme",
                        "confirmed": True,
                        "confirmation": "human_verified",
                    }
                ]
            },
        )
    )
    saved = next(call for call in store.calls if call[0] == "save_fields")[1][2]
    assert saved[0]["confirmation"] == "customer_confirmed"


def test_an_invalid_value_is_reported_and_nothing_is_written() -> None:
    store, turns = FakeStore(), AcceptedTurns()
    turns.accept()
    result = run(
        tools(store, FULL, turns).run(
            "lead_save_fields",
            {"observations": [{"key": "budget", "state": "known", "value": "5000"}]},
        )
    )
    # No currency given: the amount is not guessed into shekels.
    assert result["ok"] is False and result["field"] == "budget"
    assert not {"ensure", "save_fields"} & {call[0] for call in store.calls}
    assert turns.receipt_for_current_turn() is False


def test_a_refused_write_is_never_reported_as_saved() -> None:
    store, turns = FakeStore(), AcceptedTurns()
    runtime = tools(store, FULL, turns)
    runtime.lead_id = LEAD_ID
    turns.accept()
    store.fail_next_save = LeadStoreRefusal("LD423", "a person now owns this call")
    result = run(
        runtime.run(
            "lead_save_fields",
            {"observations": [{"key": "company", "state": "known", "value": "X"}]},
        )
    )
    assert result == {"ok": False, "error": "the action was refused", "code": "LD423"}
    assert turns.receipt_for_current_turn() is False


def test_a_dropped_answer_is_reconciled_by_operation_key_before_reporting() -> None:
    store, turns = FakeStore(), AcceptedTurns()
    runtime = tools(store, FULL, turns)
    runtime.lead_id = LEAD_ID
    turns.accept()
    store.fail_next_save = TimeoutError()
    arguments = {"observations": [{"key": "company", "state": "known", "value": "Acme"}]}
    result = run(runtime.run("lead_save_fields", arguments))
    # The write committed before the connection dropped; the receipt found by
    # the same operation key is what makes "saved" true.
    assert result["ok"] is True and result["saved"] is True
    names = [call[0] for call in store.calls]
    lost = names.index("save_fields")
    assert names[lost + 1] == "operation_receipt"
    # Retrying the identical call in the same turn replays, never re-writes.
    retry = run(runtime.run("lead_save_fields", arguments))
    assert retry["revision"] == result["revision"]
    keys = {call[1][1] for call in store.calls if call[0] == "save_fields"}
    assert len(keys) == 1


def test_an_unconfirmable_outcome_is_not_claimed() -> None:
    store, turns = FakeStore(), AcceptedTurns()
    runtime = tools(store, FULL, turns)
    runtime.lead_id = LEAD_ID
    turns.accept()

    async def lost(*_args, **_kwargs):
        raise ConnectionResetError()

    store.save_fields = lost  # type: ignore[method-assign]
    result = run(
        runtime.run(
            "lead_save_fields",
            {"observations": [{"key": "company", "state": "known", "value": "X"}]},
        )
    )
    assert result["ok"] is False and result["code"] == "outcome_unknown"
    assert turns.receipt_for_current_turn() is False


def test_a_new_caller_turn_withdraws_the_licence_to_say_saved() -> None:
    store, turns = FakeStore(), AcceptedTurns()
    runtime = tools(store, FULL, turns)
    turns.accept()
    run(
        runtime.run(
            "lead_save_fields",
            {"observations": [{"key": "company", "state": "known", "value": "X"}]},
        )
    )
    assert turns.receipt_for_current_turn() is True
    turns.accept()
    assert turns.receipt_for_current_turn() is False


def test_the_first_save_opens_the_lead_and_later_saves_reuse_it() -> None:
    store, turns = FakeStore(), AcceptedTurns()
    runtime = tools(store, FULL, turns)
    for value in ("Acme", "Acme Holdings"):
        turns.accept()
        run(
            runtime.run(
                "lead_save_fields",
                {"observations": [{"key": "company", "state": "known", "value": value}]},
            )
        )
    assert [call[0] for call in store.calls].count("ensure") == 1
    assert runtime.lead_id == LEAD_ID


def test_finalizing_before_anything_was_saved_is_refused_truthfully() -> None:
    store, turns = FakeStore(), AcceptedTurns()
    turns.accept()
    result = run(tools(store, FULL, turns).run("lead_finalize_collection", {"summary": "CRM"}))
    assert result["ok"] is False
    assert all(call[0] != "finalize" for call in store.calls)


def test_a_read_only_agent_can_read_but_not_write() -> None:
    store, turns = FakeStore(), AcceptedTurns()
    runtime = tools(store, ["lead.read"], turns)
    turns.accept()
    assert [descriptor.name for descriptor in runtime.descriptors] == ["lead_read_state"]
    write = run(
        runtime.run(
            "lead_save_fields",
            {"observations": [{"key": "company", "state": "known", "value": "X"}]},
        )
    )
    assert write["ok"] is False
    assert all(call[0] != "save_fields" for call in store.calls)
