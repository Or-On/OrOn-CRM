"""Replay the behavioural corpus against the real ``platform.lead_*`` functions.

``db/contracts/lead-capture-scenarios.v1.json`` is the single description of how
lead capture must behave. ``packages/py/oron-agent/tests/test_lead_scenario_corpus.py``
replays it in memory, where a connection can be dropped mid-write; here every
fault-free scenario runs through the real functions under the least-privileged
``platform_voice`` role, so a rule cannot pass in the tool layer and quietly
fail in the database. No model and no provider is involved: the scenario states
the tool calls a correct agent would make, and the database states the outcome.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from dispatcher_runtime.persistence import PostgresVoiceLeadStore, _async_database_url
from oron_agent.lead_capture import (
    AcceptedTurns,
    VoiceLeadTools,
    lead_completeness,
    parse_lead_field_schema,
)
from oron_agent.lead_capture_contract import CONTRACT
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from db.tests.postgres.lead_capture_support import (
    admit_callback,
    call_context,
    execute,
    seed_tenant,
)

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]

CORPUS = json.loads(
    (
        Path(__file__).resolve().parents[3] / "db" / "contracts" / "lead-capture-scenarios.v1.json"
    ).read_text(encoding="utf-8")
)
# The injected faults are a property of the harness, not of the database: a
# connection that dies between commit and acknowledgement cannot be ordered up
# here, and the in-memory suite proves that behaviour instead.
DURABLE = [scenario for scenario in CORPUS["scenarios"] if not scenario.get("faults")]
FULL_CAPABILITIES = ["lead.read", "lead.write", "lead.finalize", "lead.follow_up"]


def scenario_arguments(call: dict[str, Any]) -> dict[str, Any]:
    arguments = dict(call["arguments"])
    if arguments.get("observations") == "__oversized__":
        limit = CONTRACT["tools"]["maxObservationsPerCall"]
        arguments["observations"] = [
            {"key": "company", "state": "known", "value": f"Acme {index}"}
            for index in range(limit + 1)
        ]
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
        assert result.get("field") == expected["field"], f"{where}: {result}"
        assert expected["field"] in str(result.get("error")), f"{where}: {result}"
    if "errorContains" in expected:
        assert expected["errorContains"] in str(result.get("error")), f"{where}: {result}"
    if "missingRequired" in expected:
        assert result["missingRequired"] == expected["missingRequired"], where
    if "collectedKeys" in expected:
        collected = sorted(entry["key"] for entry in result["collected"])
        assert collected == sorted(expected["collectedKeys"]), where


def build_tools(
    maker, fixture: dict, session: UUID, handoff: UUID, scenario: dict[str, Any]
) -> tuple[AcceptedTurns, VoiceLeadTools]:
    store = PostgresVoiceLeadStore(
        maker,
        call_context(fixture, session, conversation=fixture["conversation"], handoff=handoff),
        agent_version_id=fixture["lead_agent"],
        schema_id=fixture["schema"]["id"],
        schema_version=fixture["schema"]["version"],
        business_objective=scenario["intent"][:400],
    )
    turns = AcceptedTurns()
    tools = VoiceLeadTools(
        store=store,
        schema=parse_lead_field_schema(CORPUS["schemas"][scenario["schema"]]),
        capabilities=scenario.get("capabilities", FULL_CAPABILITIES),
        interaction_key=str(session),
        turns=turns,
    )
    return turns, tools


async def replay(connection: AsyncConnection, scenario: dict[str, Any]) -> None:
    fixture = await seed_tenant(
        connection,
        fields=CORPUS["schemas"][scenario["schema"]],
        capabilities=scenario.get("capabilities", FULL_CAPABILITIES),
    )
    session, handoff = await admit_callback(connection, fixture, unlocked=True)
    maker = async_sessionmaker(
        bind=connection,
        class_=AsyncSession,
        expire_on_commit=False,
        join_transaction_mode="create_savepoint",
    )
    await execute(connection, "SET LOCAL ROLE platform_voice")
    turns, tools = build_tools(maker, fixture, session, handoff, scenario)
    if "expectToolCount" in scenario:
        assert len(tools.descriptors) == scenario["expectToolCount"], scenario["id"]

    references: dict[str, str] = {}
    previous_revision: int | None = None
    for index, turn in enumerate(scenario["turns"], start=1):
        if turn["caller"] is not None:
            turns.accept()
        for call in turn["calls"]:
            result = await tools.run(call["tool"], scenario_arguments(call))
            assert_call(scenario, call, result)
            expected = call.get("expect", {})
            if expected.get("sameRevisionAsPrevious"):
                assert result["revision"] == previous_revision, scenario["id"]
            if expected.get("sourceReference"):
                references[call["arguments"]["observations"][0]["key"]] = expected[
                    "sourceReference"
                ]
            previous_revision = result.get("revision", previous_revision)
        if scenario.get("continuesAfterTurn") == index:
            # A second admitted callback on the same conversation: new turns,
            # new operation keys, and the lead is found through the link that
            # the first leg recorded, never guessed from what the caller said.
            await execute(connection, "RESET ROLE")
            session, handoff = await admit_callback(connection, fixture, unlocked=True)
            await execute(connection, "SET LOCAL ROLE platform_voice")
            turns, tools = build_tools(maker, fixture, session, handoff, scenario)

    await execute(connection, "RESET ROLE")
    await assert_durable(connection, fixture, scenario, turns, references)


async def assert_durable(
    connection: AsyncConnection,
    fixture: dict,
    scenario: dict[str, Any],
    turns: AcceptedTurns,
    references: dict[str, str],
) -> None:
    expected = scenario["expect"]
    leads = (
        await execute(
            connection,
            "SELECT id, status FROM crm.leads WHERE tenant_id=:tenant",
            tenant=fixture["tenant"],
        )
    ).all()
    # One enquiry is one lead, whatever the model called and however often.
    assert len(leads) <= 1, scenario["id"]
    status = leads[0].status if leads else "new"
    assert status == expected["status"], scenario["id"]
    assert turns.receipt_for_current_turn() is expected["saveClaimAllowed"], scenario["id"]

    rows = (
        (
            await execute(
                connection,
                "SELECT field_key, value_state, normalized_value, value_currency, "
                "confirmation_status, source_channel, source_reference_id "
                "FROM crm.lead_field_values WHERE lead_id=:lead AND superseded_at IS NULL "
                "ORDER BY field_key",
                lead=leads[0].id,
            )
        ).all()
        if leads
        else []
    )
    observed = {
        row.field_key: {
            "state": row.value_state,
            "value": row.normalized_value,
            **({"currency": row.value_currency} if row.value_currency else {}),
            **(
                {"confirmation": row.confirmation_status}
                if row.confirmation_status != "unconfirmed"
                else {}
            ),
        }
        for row in rows
    }
    assert observed == expected["fields"], scenario["id"]
    assert {row.source_channel for row in rows} <= {"voice"}, scenario["id"]
    for key, reference in references.items():
        stored = next(row.source_reference_id for row in rows if row.field_key == key)
        assert stored == reference, scenario["id"]

    if "missingRequired" in expected:
        completeness = lead_completeness(
            parse_lead_field_schema(CORPUS["schemas"][scenario["schema"]]),
            [{"key": row.field_key, "state": row.value_state} for row in rows],
        )
        assert completeness["missing"] == expected["missingRequired"], scenario["id"]
    if "writes" in expected:
        committed = await execute(
            connection,
            "SELECT count(*) FROM crm.lead_operations WHERE lead_id=:lead "
            "AND operation='lead.save_fields' AND status='committed'",
            lead=leads[0].id,
        )
        assert committed.scalar_one() == expected["writes"], scenario["id"]


@pytest.mark.parametrize("scenario", DURABLE, ids=lambda scenario: scenario["id"])
async def test_lead_behaviour_corpus_against_postgres(postgres_url, scenario) -> None:
    engine = create_async_engine(_async_database_url(postgres_url))
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                await replay(connection, scenario)
            finally:
                await transaction.rollback()
    finally:
        await engine.dispose()


def test_the_database_replays_almost_all_of_the_corpus() -> None:
    """Only the three fault injections are excused from the durable replay."""

    excused = {scenario["id"] for scenario in CORPUS["scenarios"]} - {
        scenario["id"] for scenario in DURABLE
    }
    assert len(excused) == 3, excused
    assert len(DURABLE) >= 30
