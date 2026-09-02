"""End-to-end gate for collection: compose -> expand -> bind -> walk.

The unit tests either side of the seam can both pass while the seam is broken —
the gate writes the reask into session, and only `render_node` on the way into
the repair node turns it into speech. Nothing but a walk proves that.

Walks the PACKAGED survey flow rather than a copy of it, so the flow that ships
is the flow under test.
"""

from oron_agent.flows.binder import bind_flow
from oron_agent.flows.handlers.library import standard_handlers
from oron_agent.flows.runtime import HandlerRegistry
from oron_flows.compose import expand
from oron_flows.seeds import SURVEY_HE


def _bound():
    return bind_flow(
        expand(SURVEY_HE),
        handlers=HandlerRegistry(handlers=standard_handlers()),
    )


async def test_an_answered_question_moves_straight_on(flow_manager):
    node = _bound().initial_node()
    _, nxt = await node["functions"][0].handler({"vote_intent": "הליכוד"}, flow_manager)
    assert nxt["name"] == "ask_reason"


async def test_a_dodged_question_speaks_the_authored_reask_not_the_opener(flow_manager):
    """The seam this file exists for: the gate selects the reask, render_node
    interpolates it into the repair node's tts_say. A regression here is silent —
    the caller hears a literal ${ask_vote_reask}, or the whole greeting again."""
    node = _bound().initial_node()
    _, repair = await node["functions"][0].handler({}, flow_manager)

    assert repair["name"] == "ask_vote__repair"
    [spoken] = repair["pre_actions"]
    assert spoken["text"] == "רק שנייה — למי אתם מתכוונים להצביע?"
    assert "${" not in spoken["text"]
    assert "מדברים ממטה הבחירות" not in spoken["text"]


async def test_answering_on_the_second_attempt_proceeds(flow_manager):
    _, repair = await _bound().initial_node()["functions"][0].handler({}, flow_manager)
    _, nxt = await repair["functions"][0].handler({"vote_intent": "הליכוד"}, flow_manager)
    assert nxt["name"] == "ask_reason"
    assert flow_manager.state["session"]["vote_intent"] == "הליכוד"


async def test_a_caller_who_never_answers_is_released_not_looped(flow_manager):
    """Never stuck: the budget is spent and the flow takes the author's exit."""
    _, repair = await _bound().initial_node()["functions"][0].handler({}, flow_manager)
    _, nxt = await repair["functions"][0].handler({}, flow_manager)
    assert nxt["name"] == "thanks_partial"
    assert nxt["post_actions"] == [{"type": "end_conversation"}]
