"""`Converse` — a free-form model turn that exits when the task is done."""

import pytest
from oron_flows.components._spec import ExpandContext, get_spec
from oron_flows.components.library.basic import Collect, Converse, ConverseExit
from oron_flows.packs import INSTRUCTIONS, load_language_pack
from pydantic import ValidationError


def _ctx(**exits: str) -> ExpandContext:
    return ExpandContext(
        language="en", exits=exits, instructions=INSTRUCTIONS, pack=load_language_pack("en")
    )


def test_task_only_lets_the_model_open_the_turn():
    """No authored speech -> the model must speak on entry."""
    [node] = get_spec("converse").expand(
        Converse(id="greeting", task="Greet the caller and ask how you can help."),
        _ctx(done="collect"),
    )
    assert node.respond_immediately is True
    assert node.pre_actions == []
    assert "Greet the caller" in node.task_messages[0].content


def test_say_is_spoken_verbatim_and_defers_the_model():
    """An authored opener is spoken first; the model runs on the caller's reply."""
    [node] = get_spec("converse").expand(
        Converse(id="greeting", say="שלום, הגעתם למוקד.", task="Find out why they called."),
        _ctx(done="collect"),
    )
    assert node.respond_immediately is False
    assert node.pre_actions[0].text == "שלום, הגעתם למוקד."


def test_the_single_exit_routes_to_its_target():
    [node] = get_spec("converse").expand(
        Converse(id="collect", task="Confirm you understood."), _ctx(done="goodbye")
    )
    [fn] = node.functions
    assert fn.name == "collect_done"
    assert fn.handler == "goto"
    assert fn.parameters == []
    assert fn.routes == {ConverseExit.done: "goodbye"}


def test_registered_contract_is_task_required_say_optional():
    spec = get_spec("converse")
    props = {p.name: p for p in spec.properties}
    assert props["task"].required is True
    assert props["say"].required is False
    assert spec.default_exit == "done"


def test_registered_examples_are_domain_neutral():
    blob = repr(get_spec("converse").examples)
    assert "ברימאג" not in blob and "גילי" not in blob


def test_the_exit_is_not_described_as_fire_on_any_reply():
    """Regression: Converse used the generic `function_description` ("MUST be
    called when the customer responds"), so the node exited on the first reply
    and the flow raced to the end — the agent read as not listening."""
    [node] = get_spec("converse").expand(
        Converse(id="collect", task="Find out why they called."), _ctx(done="next")
    )
    desc = node.functions[0].description
    assert desc != INSTRUCTIONS["function_description"]
    assert "ONLY once" in desc and "objective" in desc


def test_collecting_emits_a_repair_sibling_that_does_not_replay_the_opener():
    """The whole point of a sibling: pre_actions live on the node, so routing
    retry back to `step.id` would speak the scripted greeting at someone who
    already heard it."""
    ask, repair = get_spec("converse").expand(
        Converse(
            id="ask_vote",
            say="שלום, מדברים ממטה הבחירות. למי אתם מתכוונים להצביע?",
            task="Find out who they intend to vote for.",
            collect=[
                Collect(
                    name="vote_intent",
                    describe="the party or candidate they named",
                    reask="רק שנייה — למי אתם מתכוונים להצביע?",
                )
            ],
        ),
        _ctx(done="thanks", exhausted="partial"),
    )
    assert repair.name == "ask_vote__repair"
    assert ask.pre_actions[0].text.startswith("שלום")
    assert [a.text for a in repair.pre_actions] == ["${ask_vote_reask}"]
    assert repair.respond_immediately is False


def test_the_gate_routes_retry_to_the_repair_node_and_exhausted_to_the_author():
    ask, repair = get_spec("converse").expand(
        Converse(
            id="ask_vote",
            task="Find out who they intend to vote for.",
            collect=[Collect(name="vote_intent", describe="who they will vote for", reask="למי?")],
        ),
        _ctx(done="thanks", exhausted="partial"),
    )
    for node in (ask, repair):
        [fn] = node.functions
        assert fn.handler == "collect_gate"
        assert fn.routes == {
            "done": "thanks",
            "retry": "ask_vote__repair",
            "exhausted": "partial",
        }


def test_collected_parameters_are_optional_in_the_schema_so_nothing_is_invented():
    """Required to the gate, optional to the model. Told it MUST supply a value,
    the model fabricates one rather than admitting the caller dodged."""
    ask, _ = get_spec("converse").expand(
        Converse(
            id="ask_vote",
            task="Ask who they will vote for.",
            collect=[Collect(name="vote_intent", describe="who they will vote for", reask="למי?")],
        ),
        _ctx(done="thanks", exhausted="partial"),
    )
    [param] = ask.functions[0].parameters
    assert param.name == "vote_intent"
    assert param.required is False
    assert "never guess or invent" in ask.task_messages[0].content


def test_a_required_collect_without_a_routed_exhausted_exit_is_refused():
    with pytest.raises(ValueError, match="exhausted"):
        get_spec("converse").expand(
            Converse(
                id="ask_vote",
                task="Ask who they will vote for.",
                collect=[Collect(name="vote_intent", describe="who", reask="למי?")],
            ),
            _ctx(done="thanks"),
        )


def test_a_required_collect_without_a_reask_is_refused_at_authoring_time():
    with pytest.raises(ValidationError, match="reask"):
        Collect(name="vote_intent", describe="who they will vote for")


def test_a_plain_converse_still_needs_no_exhausted_exit():
    """`exhausted` is optional: a Converse that collects nothing can never reach
    it, and demanding a target would break every existing flow."""
    [node] = get_spec("converse").expand(
        Converse(id="chat", task="Chat briefly."), _ctx(done="next")
    )
    assert node.functions[0].handler == "goto"


def test_a_terminal_node_never_gets_an_empty_instruction():
    """Heard live 2026-07-26: an authored goodbye followed by two model-invented
    ones. A terminal node still takes an LLM turn (respond_immediately must stay
    unset or the hangup is deferred), so an empty `then` is a free hand, not
    silence."""
    from oron_flows.components.library.basic import Announce

    [node] = get_spec("announce").expand(
        Announce(id="goodbye", say="תודה רבה ששיתפתם אותנו. יום טוב!"), _ctx()
    )
    content = node.task_messages[0].content.strip()
    assert content, "an empty system prompt lets the model invent its own farewell"
    assert "ALREADY been spoken" in content


def test_an_authored_then_still_drives_the_closing_turn():
    from oron_flows.components.library.basic import Announce

    [node] = get_spec("announce").expand(
        Announce(id="goodbye", then="Thank them warmly and wish them a good day."),
        _ctx(),
    )
    assert "Thank them warmly" in node.task_messages[0].content


def test_routing_exhausted_without_collecting_anything_is_refused():
    """The exit exists only when there is a required value to run out of attempts
    on. Silently dropping the route left the node it pointed at with nothing
    routing to it, so the flow was refused for an "unreachable node" naming that
    node — the one place the mistake was not."""
    with pytest.raises(ValueError, match="no required value") as e:
        get_spec("converse").expand(
            Converse(id="collect_reason", task="Find out why they called."),
            _ctx(done="goodbye", exhausted="announce"),
        )
    # Names the step, the exit and where it pointed — all three are what the
    # author needs to find it on a canvas.
    assert "collect_reason" in str(e.value)
    assert "exhausted" in str(e.value)
    assert "announce" in str(e.value)


def test_the_catalog_says_which_property_the_exhausted_exit_depends_on():
    """What lets the editor stop offering a port that would expand to nothing.

    The flag is the load-bearing half: `collect` being non-empty is not enough,
    because a list of purely optional values never exhausts either."""
    exits = {e.name: e for e in get_spec("converse").exits}
    requires = exits[ConverseExit.exhausted].requires
    assert requires is not None
    assert (requires.property, requires.flag) == ("collect", "required")
    assert exits[ConverseExit.done].requires is None


def test_routing_exhausted_with_only_optional_values_is_refused():
    """The subtler half of the same bug. With nothing collected the route was
    dropped and the flow refused; with only optional values the route was KEPT,
    the flow saved, and the node behind it simply never ran — the gate has no
    required value to run out of attempts on."""
    with pytest.raises(ValueError, match="no required value") as e:
        get_spec("converse").expand(
            Converse(
                id="collect_reason",
                task="Find out why they called.",
                collect=[Collect(name="reason", describe="why", required=False)],
            ),
            _ctx(done="goodbye", exhausted="announce"),
        )
    assert "collect_reason" in str(e.value)
    assert "announce" in str(e.value)
