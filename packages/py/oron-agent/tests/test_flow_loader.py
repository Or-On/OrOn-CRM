import uuid

from oron_agent.flows.loader import initial_node_from_composition, initial_node_from_spec
from oron_agent.support_ticket import support_ticket_function_factory
from oron_common import CallContext, Direction
from oron_flows.components.library import Announce, Converse
from oron_flows.compose import Composition, FlowMeta
from oron_flows.graph import FlowSpec
from oron_flows.node import ActionSpec, ActionType, FlowNode, FunctionSpec, Message
from oron_flows.seeds import EXAMPLE_EN, EXAMPLE_HE


def test_example_flow_loads_and_speaks_hebrew():
    node = initial_node_from_composition(EXAMPLE_HE)
    assert node["pre_actions"][0]["text"].startswith("שלום")


def test_english_example_declares_english():
    assert EXAMPLE_EN.flow.language == "en"


def test_an_unscripted_entry_uses_one_model_opener_policy():
    composition = Composition(
        flow=FlowMeta(id=uuid.uuid4(), version=1, language="en"),
        steps=[
            Converse(id="open", task="Continue from the injected WhatsApp context."),
            Announce(id="bye", say="Goodbye."),
        ],
    )

    node = initial_node_from_composition(composition)

    assert node.get("pre_actions", []) == []
    assert node["respond_immediately"] is True
    assert "WhatsApp" in node["task_messages"][0]["content"]
    assert "configured speech language code 'en'" in node["task_messages"][-1]["content"]


def test_an_unscripted_entry_carries_configured_language_without_a_response_table():
    composition = Composition(
        flow=FlowMeta(id=uuid.uuid4(), version=1, language="he"),
        steps=[
            Converse(id="open", task="Continue naturally."),
            Announce(id="bye", say="להתראות."),
        ],
    )

    node = initial_node_from_composition(composition)

    assert node.get("pre_actions", []) == []
    assert node["respond_immediately"] is True
    assert "configured speech language code 'he'" in node["task_messages"][-1]["content"]
    assert "שלום" not in node["task_messages"][-1]["content"]


def test_a_terminal_entry_keeps_its_immediate_hangup_semantics():
    spec = FlowSpec(
        id=uuid.uuid4(),
        version=1,
        language="en",
        entry="end",
        nodes=[
            FlowNode(
                name="end",
                task_messages=[Message(content="End the call politely.")],
                post_actions=[ActionSpec(type=ActionType.end_conversation)],
            )
        ],
    )

    node = initial_node_from_spec(spec)

    assert "pre_actions" not in node
    assert node.get("respond_immediately") is not False


def test_the_entry_node_is_interpolated_not_spoken_as_a_template():
    """Regression: `initial_node()` returned the compiled config unrendered, so a
    ${var} in a greeting reached TTS as a literal token and was pronounced. Only
    transition targets went through `render_node`."""
    composition = Composition(
        flow=FlowMeta(id=uuid.uuid4(), version=1, language="he"),
        steps=[
            Converse(id="open", say="שלום${contact_name} מה שלומך?", task="Chat briefly."),
            Announce(id="bye", say="להתראות."),
        ],
    )
    node = initial_node_from_composition(composition)
    assert "${" not in node["pre_actions"][0]["text"]


def test_a_broken_composition_falls_back_to_the_greeting_rather_than_killing_the_call():
    broken = Composition(
        flow=FlowMeta(id=uuid.uuid4(), version=1), steps=[], nodes=[{"name": "nowhere"}]
    )
    node = initial_node_from_composition(broken)
    assert node["task_messages"]


def test_a_broken_stored_flow_keeps_its_authoritative_role_on_recovery():
    spec = FlowSpec(
        id=uuid.uuid4(),
        version=3,
        language="he",
        role_message="You are the support representative of Tenant A Support.",
        entry="open",
        nodes=[
            {
                "name": "open",
                "functions": [
                    FunctionSpec(
                        name="broken",
                        description="broken fixture",
                        handler="missing_handler",
                        routes={"ok": "open"},
                    )
                ],
            }
        ],
    )

    node = initial_node_from_spec(spec)

    assert node["role_message"] == spec.role_message
    assert "configured speech language code 'he'" in node["task_messages"][0]["content"]


def test_a_conversational_node_receives_the_verified_ticket_tool_without_phone_fields():
    context = CallContext(
        call_id="call-1",
        direction=Direction.INBOUND,
        from_number="+972501234567",
        flow_id=uuid.uuid4(),
        tenant_id=uuid.uuid4(),
    )
    spec = FlowSpec(
        id=context.flow_id,
        version=1,
        language="he",
        entry="open",
        nodes=[FlowNode(name="open", task_messages=[Message(content="Help the caller.")])],
    )

    node = initial_node_from_spec(
        spec,
        runtime_function_factories=(support_ticket_function_factory(object(), context, {}),),
    )

    ticket_tool = next(fn for fn in node["functions"] if fn.name == "open_support_ticket")
    assert ticket_tool.required == ["subject", "summary"]
    assert "phone" not in ticket_tool.properties
