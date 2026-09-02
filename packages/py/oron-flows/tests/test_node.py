import pytest
from oron_flows.node import (
    ActionSpec,
    ActionType,
    EnterSpec,
    FlowNode,
    FunctionSpec,
    Message,
    MessageRole,
    ParameterSpec,
)
from pydantic import ValidationError

DESK = "+14155552671"
"""libphonenumber's own example number. Never a real desk: a number committed to a
test gets dialled by someone eventually."""


def test_message_role_defaults_to_system_and_rejects_junk():
    assert Message(content="x").role is MessageRole.system
    with pytest.raises(ValidationError):
        Message(role="wizard", content="x")


def test_tts_say_requires_text_and_delay_requires_seconds():
    with pytest.raises(ValidationError):
        ActionSpec(type=ActionType.tts_say)
    with pytest.raises(ValidationError):
        ActionSpec(type=ActionType.delay)


def test_end_conversation_needs_no_payload():
    action = ActionSpec(type=ActionType.end_conversation)
    assert action.text is None and action.seconds is None


def test_transfer_requires_a_valid_e164_target():
    with pytest.raises(ValidationError):
        ActionSpec(type=ActionType.transfer)
    with pytest.raises(ValidationError):
        ActionSpec(type=ActionType.transfer, to="not a number")
    assert ActionSpec(type=ActionType.transfer, to=DESK).to == DESK


def test_a_transfer_node_is_terminal():
    """Terminality is what keeps globals off the node — a transfer the model can
    transition away from is not a transfer."""
    node = FlowNode(name="to_human", post_actions=[ActionSpec(type=ActionType.transfer, to=DESK)])
    assert node.is_terminal


def test_on_enter_names_a_handler_and_its_config():
    spec = EnterSpec(handler="fetch_slots", config={"page_size": 5})
    assert spec.handler == "fetch_slots"
    assert spec.config["page_size"] == 5


def test_node_round_trips_through_json():
    node = FlowNode(
        name="q",
        task_messages=[Message(content="ask something")],
        pre_actions=[ActionSpec(type=ActionType.tts_say, text="${choices_text}")],
        on_enter=EnterSpec(handler="fetch_slots", config={"page_size": 5}),
        respond_immediately=False,
        functions=[
            FunctionSpec(
                name="q_answer",
                description="MUST be called.",
                parameters=[ParameterSpec(name="value", type="boolean")],
                handler="route_by",
                config={"arg": "value", "on": {"true": "affirmed", "false": "declined"}},
                routes={"affirmed": "next", "declined": "elsewhere"},
            )
        ],
    )
    assert FlowNode(**node.model_dump(mode="json")) == node


def test_duplicate_function_names_in_one_node_are_rejected():
    fn = FunctionSpec(name="same", description="d", handler="goto", routes={})
    with pytest.raises(ValidationError, match="duplicate function"):
        FlowNode(name="n", functions=[fn, fn.model_copy()])
