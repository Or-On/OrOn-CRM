"""`Branch` — route on what the caller said."""

import pytest
from oron_flows.components._spec import ExpandContext, get_spec
from oron_flows.components.library.basic import Branch, Choice
from oron_flows.packs import INSTRUCTIONS, load_language_pack
from pydantic import ValidationError


def _ctx(**exits: str) -> ExpandContext:
    return ExpandContext(
        language="he", exits=exits, instructions=INSTRUCTIONS, pack=load_language_pack("he")
    )


def _gate(**kwargs) -> Branch:
    return Branch(
        id="b_open",
        say="שלום, שמי אור ממטה הבחירות. יש לי רגע אחד?",
        ask="whether the voter agreed to continue the call now",
        choices={
            "yes": Choice(describe="They agreed to talk.", to="b_pitch"),
            "no": Choice(describe="They declined or asked not to be called.", to="b_end_respect"),
        },
        **kwargs,
    )


def test_each_choice_routes_to_its_own_target():
    [node] = get_spec("branch").expand(_gate(), _ctx())
    [fn] = node.functions
    assert fn.handler == "route_by"
    assert fn.routes == {"yes": "b_pitch", "no": "b_end_respect", "error": "b_open"}


def test_the_choice_is_an_enum_the_model_must_supply():
    """Unlike a collected fact, a classification is always answerable — the model
    is being asked for its own judgement, not for something the caller may never
    have said, so requiring it does not invite invention."""
    [node] = get_spec("branch").expand(_gate(), _ctx())
    [param] = node.functions[0].parameters
    assert param.name == "choice"
    assert param.enum == ["yes", "no"]
    assert param.required is True


def test_route_by_config_maps_every_choice():
    [node] = get_spec("branch").expand(_gate(sets="consent"), _ctx())
    config = node.functions[0].config
    assert config == {"arg": "choice", "on": {"yes": "yes", "no": "no"}, "sets": "consent"}


def test_sets_is_omitted_when_the_outcome_is_not_worth_recording():
    [node] = get_spec("branch").expand(_gate(), _ctx())
    assert "sets" not in node.functions[0].config


def test_an_authored_question_defers_the_model_like_every_other_component():
    [node] = get_spec("branch").expand(_gate(), _ctx())
    assert node.pre_actions[0].text.startswith("שלום")
    assert node.respond_immediately is False


def test_a_branch_with_no_authored_line_lets_the_model_speak():
    """A branch reading an answer already given has nothing to say first."""
    [node] = get_spec("branch").expand(
        Branch(
            id="classify",
            ask="which objection the voter raised",
            choices={
                "brand": Choice(describe="They dislike the party.", to="a"),
                "cynical": Choice(describe="They think all politicians lie.", to="b"),
            },
        ),
        _ctx(),
    )
    assert node.pre_actions == []
    assert node.respond_immediately is True


def test_the_options_reach_the_model_but_are_not_to_be_read_aloud():
    [node] = get_spec("branch").expand(_gate(), _ctx())
    content = node.task_messages[0].content
    assert "yes: They agreed to talk." in content
    assert "never read the list aloud" in content


def test_a_single_outcome_is_refused_as_not_a_branch():
    with pytest.raises(ValidationError, match="not a branch"):
        Branch(
            id="pointless",
            ask="whether they agreed",
            choices={"yes": Choice(describe="They agreed.", to="next")},
        )


def test_routing_a_branch_through_on_is_refused():
    """Branch declares no exits, so the unknown-exit guard catches an author who
    reaches for `on:` out of habit instead of silently ignoring it."""
    import uuid

    from oron_flows.compose import Composition, FlowMeta, expand

    with pytest.raises(ValueError, match="unknown exit"):
        expand(
            Composition(
                flow=FlowMeta(id=uuid.uuid4(), version=1, language="he"),
                steps=[_gate(on={"yes": "b_pitch"})],
            )
        )
