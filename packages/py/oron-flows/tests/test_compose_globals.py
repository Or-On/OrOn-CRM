import uuid

import pytest
from oron_flows.components.library.basic import Announce, Inform
from oron_flows.compose import Composition, FlowMeta, GlobalEdge, expand
from oron_flows.packs import INSTRUCTIONS

STEPS = [Inform(id="a", say="שלום"), Inform(id="b", say="עוד?"), Announce(id="done", then="bye")]


def _composition(**kw) -> Composition:
    base = dict(
        flow=FlowMeta(id=uuid.uuid4(), version=1, language="he"),
        steps=STEPS,
        globals=[
            GlobalEdge(
                id="caller_goodbye",
                to="done",
                when="the caller says goodbye or asks to end the call",
            )
        ],
    )
    return Composition(**{**base, **kw})


def test_a_global_is_attached_to_every_non_terminal_node():
    spec = expand(_composition())
    for name in ("a", "b"):
        assert "global_caller_goodbye" in {f.name for f in spec.node(name).functions}


def test_a_global_is_not_attached_to_a_terminal_node():
    assert expand(_composition()).node("done").functions == []


def test_the_condition_becomes_the_function_description():
    fn = next(
        f for f in expand(_composition()).node("a").functions if f.name == "global_caller_goodbye"
    )
    # Contains, not equals: the condition is what the model selects on, but the
    # description also has to tell it to transition SILENTLY. Heard live
    # 2026-07-26 — the model called the goodbye global AND narrated
    # "תודה רבה ויום טוב", so the caller was thanked twice, once by the model and
    # once by the terminal node it had just moved to. Every other function
    # carries `function_description`, which ends "Do NOT generate text".
    assert "the caller says goodbye or asks to end the call" in fn.description
    # Asserted against the SHARED fragment, not a literal: a global and a
    # converse exit must carry the same silence rule, and pinning the wording
    # twice is how the four hand-written copies drifted in the first place.
    silence = INSTRUCTIONS["converse_exit_description"].split("instead. ", 1)[1]
    assert silence in fn.description
    assert fn.handler == "goto"
    assert fn.routes == {"caller_goodbye": "done"}
    assert fn.parameters == []


def test_a_global_pointing_at_an_unknown_node_is_rejected():
    with pytest.raises(ValueError, match="unknown node"):
        expand(_composition(globals=[GlobalEdge(id="g", to="ghost", when="x")]))


def test_two_globals_with_the_same_id_collide():
    with pytest.raises(ValueError, match="collides with function"):
        expand(
            _composition(
                globals=[
                    GlobalEdge(id="g", to="done", when="x"),
                    GlobalEdge(id="g", to="done", when="y"),
                ]
            )
        )


def test_a_flow_without_globals_is_unchanged():
    assert {f.name for f in expand(_composition(globals=[])).node("a").functions} == {"a_answer"}
