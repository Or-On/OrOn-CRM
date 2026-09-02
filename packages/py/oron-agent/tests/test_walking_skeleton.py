"""End-to-end gate: a typed composition becomes a live pipecat NodeConfig.

Deliberately uses the two most trivial components. Every task after Task 6
re-runs this file — if the component/binder contract drifts, this breaks first.
"""

import uuid

from oron_agent.flows.binder import bind_flow
from oron_agent.flows.handlers.library import standard_handlers
from oron_agent.flows.runtime import HandlerRegistry
from oron_flows.components.library.basic import Announce, Inform
from oron_flows.compose import Composition, FlowMeta, Persona, expand

FLOW_ID = uuid.uuid4()

SKELETON = Composition(
    flow=FlowMeta(id=FLOW_ID, version=1, language="en"),
    persona=Persona(agent_name="Noa", org="the service desk", gender="female"),
    steps=[
        Inform(id="greeting", say="Hello, how can I help?"),
        Announce(id="goodbye", say="Goodbye.", then="Say nothing more."),
    ],
)


def _bound():
    return bind_flow(
        expand(SKELETON),
        handlers=HandlerRegistry(handlers=standard_handlers()),
    )


def test_a_typed_composition_becomes_a_bindable_flow():
    bound = _bound()
    assert bound.spec.entry == "greeting"
    assert {n.name for n in bound.spec.nodes} == {"greeting", "goodbye"}


def test_the_composition_round_trips_through_json():
    """JSON is the storage format — the models must survive it."""
    restored = Composition(**SKELETON.model_dump(mode="json"))
    assert expand(restored).model_dump() == expand(SKELETON).model_dump()


def test_the_entry_node_is_a_real_pipecat_node_config():
    cfg = _bound().initial_node()
    assert cfg["name"] == "greeting"
    assert cfg["pre_actions"] == [{"type": "tts_say", "text": "Hello, how can I help?"}]
    assert cfg["task_messages"][0]["role"] == "system"
    assert cfg["functions"][0].name == "greeting_answer"
    assert callable(cfg["functions"][0].handler)


def test_the_persona_reaches_every_node():
    bound = _bound()
    assert "Noa" in bound.initial_node()["role_message"]
    assert "the service desk" in bound.configs["goodbye"]["role_message"]


async def test_walking_the_flow_reaches_the_terminal_node():
    class FM:
        state: dict = {}

    _, node = await _bound().initial_node()["functions"][0].handler({}, FM())
    assert node["name"] == "goodbye"
    assert node["post_actions"] == [{"type": "end_conversation"}]
    # The hangup must not be deferred behind the spoken goodbye.
    assert node.get("respond_immediately") is not False
