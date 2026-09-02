import uuid

import pytest
from oron_flows.components.library.basic import Announce, Inform
from oron_flows.compose import Composition, FlowMeta, Persona, expand


def _composition(steps, **kw) -> Composition:
    base = dict(
        flow=FlowMeta(id=uuid.uuid4(), version=1, language="he"),
        persona=Persona(agent_name="נועה", org="המוקד", gender="female"),
        steps=steps,
    )
    return Composition(**{**base, **kw})


def test_default_exit_falls_through_to_the_next_step():
    spec = expand(_composition([Inform(id="a", say="שלום"), Announce(id="b", then="bye")]))
    assert spec.node("a").functions[0].routes["acknowledged"] == "b"


def test_named_exit_overrides_fall_through():
    # `a` is the only step, so its default exit has nowhere to fall through
    # (see the sibling test); naming it in `on` routes it to a raw terminal node
    # instead, proving the explicit mapping is honoured over the default.
    #
    # A named exit that *skips an adjacent step* is deliberately NOT tested here:
    # with a single-exit `Inform` it would orphan the skipped node, which the
    # reachability validator correctly rejects. That case only becomes
    # expressible with the multi-exit components in PR2.
    spec = expand(
        _composition(
            [Inform(id="a", say="שלום", on={"acknowledged": "done"})],
            nodes=[
                {
                    "name": "done",
                    "task_messages": [{"content": "bye"}],
                    "post_actions": [{"type": "end_conversation"}],
                }
            ],
        )
    )
    assert spec.node("a").functions[0].routes["acknowledged"] == "done"


def test_default_exit_on_the_last_step_has_nowhere_to_fall_through():
    with pytest.raises(ValueError, match="nowhere to fall through"):
        expand(_composition([Inform(id="a", say="שלום")]))


def test_entry_is_the_first_step():
    spec = expand(_composition([Inform(id="first", say="שלום"), Announce(id="last", then="bye")]))
    assert spec.entry == "first"


def test_persona_becomes_the_flow_role_message():
    spec = expand(_composition([Announce(id="a", then="bye")]))
    assert "נועה" in spec.role_message and "המוקד" in spec.role_message


def test_steps_hydrate_from_json_into_their_concrete_models():
    """The store round-trip: dicts must come back as typed steps."""
    raw = {
        "flow": {"id": str(uuid.uuid4()), "version": 1, "language": "he"},
        "steps": [
            {"id": "a", "use": "inform", "say": "שלום"},
            {"id": "b", "use": "announce", "then": "bye"},
        ],
    }
    composition = Composition(**raw)
    assert isinstance(composition.steps[0], Inform)
    assert composition.steps[0].say == "שלום"


def test_an_unknown_property_is_rejected_at_author_time():
    with pytest.raises(ValueError):
        Composition(
            flow=FlowMeta(id=uuid.uuid4(), version=1),
            steps=[{"id": "a", "use": "inform", "say": "x", "bogus": 1}],
        )


def test_raw_nodes_are_spliced_in_as_the_escape_hatch():
    spec = expand(
        _composition(
            [Inform(id="a", say="שלום", on={"acknowledged": "custom"})],
            nodes=[{"name": "custom", "task_messages": [{"content": "hand-authored"}]}],
        )
    )
    assert spec.node("custom").task_messages[0].content == "hand-authored"


def test_duplicate_step_id_is_rejected():
    with pytest.raises(ValueError, match="duplicate"):
        expand(_composition([Announce(id="a", then="x"), Announce(id="a", then="y")]))


def test_unknown_component_names_the_known_ones():
    with pytest.raises(KeyError, match="unknown component"):
        Composition(
            flow=FlowMeta(id=uuid.uuid4(), version=1), steps=[{"id": "a", "use": "does_not_exist"}]
        )


def test_a_typo_in_an_on_key_is_rejected_not_silently_dropped():
    with pytest.raises(ValueError, match="unknown exit"):
        expand(
            _composition(
                [Inform(id="a", say="hi", on={"aknowledged": "b"}), Announce(id="b", then="bye")]
            )
        )
