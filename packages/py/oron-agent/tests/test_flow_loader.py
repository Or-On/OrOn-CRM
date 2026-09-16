import uuid

from oron_agent.flows.loader import initial_node_from_composition, initial_node_from_spec
from oron_flows.components.library import Announce, Converse
from oron_flows.compose import Composition, FlowMeta
from oron_flows.graph import FlowSpec
from oron_flows.node import ActionSpec, ActionType, FlowNode, Message
from oron_flows.seeds import EXAMPLE_EN, EXAMPLE_HE


def test_example_flow_loads_and_speaks_hebrew():
    node = initial_node_from_composition(EXAMPLE_HE)
    assert node["pre_actions"][0]["text"].startswith("שלום")


def test_english_example_declares_english():
    assert EXAMPLE_EN.flow.language == "en"


def test_an_unscripted_entry_uses_a_deterministic_opener_before_the_llm():
    composition = Composition(
        flow=FlowMeta(id=uuid.uuid4(), version=1, language="en"),
        steps=[
            Converse(id="open", task="Continue from the injected WhatsApp context."),
            Announce(id="bye", say="Goodbye."),
        ],
    )

    node = initial_node_from_composition(composition)

    assert node["pre_actions"] == [
        {"type": "tts_say", "text": "Hello, this is support. How can I help?"}
    ]
    assert node["respond_immediately"] is False
    assert "WhatsApp" in node["task_messages"][0]["content"]


def test_a_hebrew_unscripted_entry_is_short_neutral_and_deterministic():
    composition = Composition(
        flow=FlowMeta(id=uuid.uuid4(), version=1, language="he"),
        steps=[
            Converse(id="open", task="Continue naturally."),
            Announce(id="bye", say="להתראות."),
        ],
    )

    node = initial_node_from_composition(composition)

    assert node["pre_actions"] == [{"type": "tts_say", "text": "שלום, כאן התמיכה. איך אפשר לעזור?"}]
    assert node["respond_immediately"] is False


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
