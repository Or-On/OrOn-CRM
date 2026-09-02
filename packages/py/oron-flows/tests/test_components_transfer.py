"""The Transfer component.

Most of these pin a SHAPE rather than a behaviour, because the behaviour lives in
pipecat: it blocks a custom action behind a preceding `tts_say` in the same action
list, and that is the only thing making the REFER land after the caller has been
told. Break the shape and the ordering guarantee goes with it, silently.
"""

import uuid

from oron_flows.components.library.basic import Inform, Transfer
from oron_flows.compose import Composition, FlowMeta, GlobalEdge, expand
from oron_flows.node import ActionType

DESK = "+14155552671"


def _composition(**kw) -> Composition:
    base = dict(
        flow=FlowMeta(id=uuid.uuid4(), version=1, language="he"),
        steps=[
            Inform(id="a", say="שלום"),
            Transfer(id="to_human", say="מעביר אותך לנציג, רגע אחד", to=DESK),
        ],
    )
    return Composition(**{**base, **kw})


def _node(**kw):
    return expand(_composition(**kw)).node("to_human")


def test_the_line_and_the_refer_are_one_ordered_post_action_list():
    node = _node()
    assert [a.type for a in node.post_actions] == [ActionType.tts_say, ActionType.transfer]
    assert node.post_actions[0].text == "מעביר אותך לנציג, רגע אחד"
    assert node.post_actions[1].to == DESK
    # In pre_actions the REFER would not wait for the line — the caller gets
    # moved mid-sentence.
    assert node.pre_actions == []


def test_respond_immediately_is_left_unset():
    """False defers post_actions onto a BotStoppedSpeakingFrame that a node with no
    LLM turn never emits, so the transfer would never fire at all."""
    assert _node().respond_immediately is None


def test_a_global_is_not_attached_to_a_transfer_node():
    """Terminality earns its keep here: a goto per global would let the model
    leave instead of transferring."""
    node = _node(globals=[GlobalEdge(id="bye", to="to_human", when="the caller asks for a person")])
    assert node.functions == []
