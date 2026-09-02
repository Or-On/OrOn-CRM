"""The packaged examples are PR 1's regression guard: a composition must expand,
bind, and walk the branch the old YAML described."""

import pytest
from oron_agent.flows.binder import bind_flow
from oron_agent.flows.handlers.library import standard_handlers
from oron_agent.flows.runtime import HandlerRegistry
from oron_flows.compose import expand
from oron_flows.seeds import (
    CANVASS_HE_ID,
    EXAMPLE_EN,
    EXAMPLE_EN_ID,
    EXAMPLE_HE,
    EXAMPLE_HE_ID,
    SEED_COMPOSITIONS,
    SURVEY_HE_ID,
)


def _bind(composition):
    return bind_flow(
        expand(composition),
        handlers=HandlerRegistry(handlers=standard_handlers()),
    )


def test_hebrew_example_speaks_its_greeting_verbatim():
    node = _bind(EXAMPLE_HE).initial_node()
    assert node["pre_actions"][0]["text"] == "שלום, הגעתם למוקד. איך אפשר לעזור?"
    assert node["respond_immediately"] is False  # authored opener -> model waits


def test_english_example_lets_the_model_open():
    node = _bind(EXAMPLE_EN).initial_node()
    assert node.get("pre_actions", []) == []
    assert node["respond_immediately"] is True


async def test_hebrew_example_walks_greeting_to_collect_to_goodbye():
    bound = _bind(EXAMPLE_HE)

    class FM:
        state: dict = {}

    node = bound.initial_node()
    _, node = await node["functions"][0].handler({}, FM())
    assert node["name"] == "collect_reason"

    _, node = await node["functions"][0].handler({}, FM())
    assert node["name"] == "goodbye"
    assert node["post_actions"] == [{"type": "end_conversation"}]


async def test_the_global_escape_reaches_goodbye_from_the_first_node():
    bound = _bind(EXAMPLE_HE)

    class FM:
        state: dict = {}

    functions = {f.name: f for f in bound.initial_node()["functions"]}
    assert "global_caller_goodbye" in functions
    _, node = await functions["global_caller_goodbye"].handler({}, FM())
    assert node["name"] == "goodbye"


def test_every_packaged_flow_is_registered_for_the_publish_cli():
    assert set(SEED_COMPOSITIONS) == {
        EXAMPLE_HE_ID,
        EXAMPLE_EN_ID,
        SURVEY_HE_ID,
        CANVASS_HE_ID,
    }


@pytest.mark.parametrize(
    "composition", SEED_COMPOSITIONS.values(), ids=[str(k) for k in SEED_COMPOSITIONS]
)
def test_transition_targets_are_authored_so_entry_costs_no_llm_call(composition):
    """A node entered by a transition should speak authored text: `say` fires as
    a tts_say pre-action with respond_immediately=False, so pipecat does not run
    the LLM on entry. Only the terminal node is exempt — it must not defer its
    own hangup.
    """
    spec = expand(composition)
    entered = {
        target for node in spec.nodes for fn in node.functions for target in fn.routes.values()
    }
    for name in entered:
        node = spec.node(name)
        terminal = any(a.type == "end_conversation" for a in node.post_actions)
        if terminal:
            continue
        assert node.pre_actions, f"'{name}' is a transition target with no authored say"
        assert node.respond_immediately is False, f"'{name}' would let the LLM speak over its say"
