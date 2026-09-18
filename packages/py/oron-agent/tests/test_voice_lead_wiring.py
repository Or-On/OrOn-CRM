"""How a published agent's lead actions reach a call, and what they license."""

from __future__ import annotations

import asyncio
from uuid import uuid4

import pytest
from oron_agent.bot import build_voice_lead_tools
from oron_agent.flows.binder import bind_flow
from oron_agent.flows.resolve import StoredFlowUnavailable
from oron_agent.flows.runtime import HandlerContext, HandlerRegistry, HandlerResult
from oron_agent.grounding import grounding_instruction, render_reply
from oron_agent.lead_capture import AcceptedTurns
from oron_agent.spoken_safety import safe_spoken_text
from oron_common import CallContext, Direction
from oron_flows.graph import FlowSpec
from oron_flows.node import ActionSpec, ActionType, FlowNode, FunctionSpec, Message

FIELDS = [{"key": "company", "label": "Company", "type": "text", "required": True}]


def _context(contact: bool = True) -> CallContext:
    return CallContext(
        call_id="wiring",
        tenant_id=uuid4(),
        flow_id=uuid4(),
        direction=Direction.OUTBOUND,
        contact_id=uuid4() if contact else None,
    )


class Sessions:
    def __init__(self, schema: dict | None = None) -> None:
        self.schema = schema
        self.stores: list[dict] = []

    async def get_lead_field_schema(self, schema_id: str, *, tenant_id) -> dict | None:
        return self.schema

    def lead_store(self, ctx, *, agent_version_id, schema, business_objective):
        self.stores.append({"agent": agent_version_id, "schema": schema})
        return object()


def _configuration(capabilities: list[str], schema_id: str | None = "schema-1") -> dict:
    return {
        "agentVersionId": str(uuid4()),
        "capabilities": capabilities,
        "leadFieldSchemaId": schema_id,
        "roleTitle": "Lead coordinator",
    }


def test_an_agent_without_lead_capabilities_gets_no_lead_runtime() -> None:
    sessions = Sessions()
    tools = asyncio.run(
        build_voice_lead_tools(sessions, _context(), _configuration([]), AcceptedTurns())
    )
    assert tools is None
    assert sessions.stores == []


def test_a_lead_agent_gets_exactly_its_published_tools() -> None:
    sessions = Sessions({"id": "schema-1", "version": 1, "definition": FIELDS})
    tools = asyncio.run(
        build_voice_lead_tools(
            sessions, _context(), _configuration(["lead.write"]), AcceptedTurns()
        )
    )
    assert tools is not None
    assert [descriptor.name for descriptor in tools.descriptors] == [
        "lead_read_state",
        "lead_save_fields",
    ]


def test_an_unexecutable_lead_publication_stops_the_call_instead_of_degrading() -> None:
    with pytest.raises(StoredFlowUnavailable):
        asyncio.run(
            build_voice_lead_tools(
                Sessions(None), _context(), _configuration(["lead.write"]), AcceptedTurns()
            )
        )
    with pytest.raises(StoredFlowUnavailable):
        asyncio.run(
            build_voice_lead_tools(
                Sessions(), _context(), _configuration(["lead.write"], None), AcceptedTurns()
            )
        )


def test_an_unidentified_caller_gets_no_lead_actions() -> None:
    sessions = Sessions({"id": "schema-1", "version": 1, "definition": FIELDS})
    tools = asyncio.run(
        build_voice_lead_tools(
            sessions, _context(contact=False), _configuration(["lead.write"]), AcceptedTurns()
        )
    )
    assert tools is None


async def _route(ctx: HandlerContext) -> HandlerResult:
    return HandlerResult(route="done")


def test_call_functions_ride_on_conversing_nodes_but_not_on_the_ending() -> None:
    spec = FlowSpec(
        id=uuid4(),
        version=1,
        entry="talk",
        nodes=[
            FlowNode(
                name="talk",
                task_messages=[Message(content="talk")],
                functions=[
                    FunctionSpec(
                        name="finish", description="d", handler="route", routes={"done": "bye"}
                    )
                ],
            ),
            FlowNode(
                name="bye",
                task_messages=[Message(content="bye")],
                post_actions=[ActionSpec(type=ActionType.end_conversation)],
            ),
        ],
    )
    marker = object()
    bound = bind_flow(
        spec,
        handlers=HandlerRegistry(handlers={"route": _route}),
        call_functions=[marker],  # type: ignore[list-item]
    )
    talk = bound.configs["talk"]["functions"]
    # The authored routing function stays, and the agent's action is added.
    assert [getattr(function, "name", None) for function in talk][0] == "finish"
    assert marker in talk
    assert "functions" not in bound.configs["bye"]


def test_the_action_policy_follows_what_the_agent_holds() -> None:
    plain = grounding_instruction([], "he")
    assert "normal conversation must not invoke a tool" in plain
    lead = grounding_instruction([], "he", ("lead_read_state", "lead_save_fields"))
    # A lead agent is not told the opposite of what its own prompt asks.
    assert "normal conversation must not invoke a tool" not in lead
    assert "lead_save_fields" in lead and "receipt" in lead
    assert lead.startswith("VOICE EVIDENCE AND ACTION SAFETY POLICY v3.")


@pytest.mark.parametrize(
    ("text", "language"),
    [
        ("שמרתי את הפרטים שלך, תודה.", "he"),
        ("הפרטים שלך נשמרו במערכת.", "he"),
        ("I've saved your details.", "en"),
        ("Your information has been recorded.", "en"),
    ],
)
def test_a_save_claim_needs_a_receipt_for_this_turn(text: str, language: str) -> None:
    # An agent without lead actions: unchanged behaviour.
    assert safe_spoken_text(text, language) == (text, False)
    # A lead agent whose write committed for this turn may say so.
    assert safe_spoken_text(text, language, save_claim_receipted=True) == (text, False)
    # Without the receipt the claim is replaced, never spoken.
    spoken, suppressed = safe_spoken_text(text, language, save_claim_receipted=False)
    assert suppressed is True and spoken != text


def test_ordinary_lead_conversation_is_not_mistaken_for_a_claim() -> None:
    for text in (
        "מה שם החברה שלך?",
        "אפשר לשמור את הפרטים שלך?",
        "Would you like me to save your details?",
        "How many users will need access?",
    ):
        assert safe_spoken_text(text, "he", save_claim_receipted=False) == (text, False)


def test_the_evidence_gate_applies_the_same_receipt_rule() -> None:
    claim = "<lang:en>I've saved your details."
    assert render_reply(claim, [], "en", save_claim_receipted=False).decision == (
        "suppressed_unverified_claim"
    )
    assert render_reply(claim, [], "en", save_claim_receipted=True).decision == (
        "natural_conversation"
    )
