"""The canvass `talk` node must not end the call or invent policy.

Both rules exist because of one live call on 2026-07-27. The model said
"תודה רבה לך על השיחה... יום מקסים!", the caller answered "ביי ביי", and only
then did the flow reach `close` and ask for their vote — two goodbyes with the
ask sandwiched between them. In the same call it answered a tax question with
"he genuinely believes in lowering the burden and lowering prices", a campaign
promise nobody authorised.
"""

import pytest
from oron_flows.compose import expand
from oron_flows.seeds import CANVASS_HE


@pytest.fixture
def talk_task() -> str:
    spec = expand(CANVASS_HE)
    node = next(n for n in spec.nodes if n.name == "talk")
    return " ".join(m.content for m in node.task_messages).lower()


def test_talk_is_told_never_to_end_the_conversation(talk_task):
    """`converse_exit_description` only forbids narrating while calling the exit
    function. Signing off in an ordinary turn and transitioning a beat later
    satisfies that rule and still ruins the call, so the ban has to be about the
    conversation rather than the transition."""
    assert "never end this conversation" in talk_task
    assert "do not say goodbye" in talk_task


def test_the_exit_is_named_inside_the_rule_that_forbids_leaving(talk_task):
    """Naming `talk_done` somewhere is not enough — the compiler already appends
    'When that is done, you MUST call talk_done' at the end, and the prompt still
    failed. Four paragraphs earlier the model is told NEVER END THIS CONVERSATION,
    not even if they say goodbye first, and the loud adjacent instruction wins:
    gemma-4-31b exited 6/12 where Gemini exited 12/12. Resolving the contradiction
    *inside* the same paragraph took both to 12/12, which is why this asserts
    co-location rather than presence."""
    talk = next(n for n in expand(CANVASS_HE).nodes if n.name == "talk")
    assert "talk_done" in {f.name for f in talk.functions}

    block = next(b for b in talk_task.split("\n\n") if "never end this conversation" in b)
    assert "talk_done" in block, "the exit must be named where the model is told not to leave"


def test_talk_still_refuses_to_exit_mid_objection(talk_task):
    """The counterweight to the rule above. An exit instruction with no brake
    trades a bot that traps people for one that hangs up on them."""
    assert "still asking things or raising objections" in talk_task


def test_the_rank_claim_carries_its_hebrew_form(talk_task):
    """An English-only claim costs a translation on every mention, and that is
    where the drift lives: gemma-4-31b promoted a real minister to סגן אלוף and
    once demoted him to סגן, ~1 in 4 times it volunteered the rank. With the
    Hebrew token supplied it was 15/15 correct."""
    assert "רב סרן" in talk_task


def test_talk_is_told_not_to_promise_anything(talk_task):
    """The four permitted claims are his record. A belief or intention is not a
    fact, so 'never add facts beyond these four' did not cover it."""
    assert "never promise anything" in talk_task


def test_the_closing_question_still_belongs_to_the_close_node(talk_task):
    """The new rule must not tip the model into asking for the vote itself —
    that is what `close` is for, and it is where the answer gets recorded."""
    assert "do not ask them for their vote" in talk_task


def test_close_still_asks_for_the_vote_and_records_the_answer():
    """If `talk` no longer closes, something must — and the campaign needs the
    stance stored, not just spoken."""
    spec = expand(CANVASS_HE)
    close = next(n for n in spec.nodes if n.name == "close")

    assert any("תשקול לתת את קולך" in (a.text or "") for a in close.pre_actions)
    assert {f.name for f in close.functions} >= {"close_choose"}
