import itertools
import uuid

import pytest
from oron_agent.flows.binder import bind_flow
from oron_agent.flows.runtime import (
    HandlerContext,
    HandlerRegistry,
    HandlerResult,
)
from oron_flows.graph import FlowSpec
from oron_flows.node import (
    ActionSpec,
    ActionType,
    EnterSpec,
    FlowNode,
    FunctionSpec,
    Message,
    ParameterSpec,
)


async def _echo(ctx: HandlerContext) -> HandlerResult:
    return HandlerResult(
        route=ctx.config["route"],
        data={"seen": ctx.args.get("value")},
        public={"shown": ctx.config.get("public_note", "")},
    )


def _handlers(**extra) -> HandlerRegistry:
    return HandlerRegistry(handlers={"echo": _echo, **extra})


class FM:
    def __init__(self):
        self.state: dict = {}


def _spec(config: dict, routes: dict, target_extra: dict | None = None, **flow_kw) -> FlowSpec:
    return FlowSpec(
        id=uuid.uuid4(),
        version=1,
        entry="a",
        nodes=[
            FlowNode(
                name="a",
                task_messages=[Message(content="do the thing")],
                pre_actions=[ActionSpec(type=ActionType.tts_say, text="שלום")],
                functions=[
                    FunctionSpec(
                        name="a_answer",
                        description="MUST be called.",
                        parameters=[ParameterSpec(name="value", type="boolean")],
                        handler="echo",
                        config=config,
                        routes=routes,
                    )
                ],
            ),
            FlowNode(
                name="b", task_messages=[Message(content="done ${seen}")], **(target_extra or {})
            ),
        ],
        **flow_kw,
    )


def test_node_config_is_pipecat_shaped():
    cfg = bind_flow(
        _spec({"route": "ok"}, {"ok": "b"}),
        handlers=_handlers(),
    ).initial_node()
    assert cfg["name"] == "a"
    assert cfg["task_messages"] == [{"role": "system", "content": "do the thing"}]
    assert cfg["pre_actions"] == [{"type": "tts_say", "text": "שלום"}]
    assert cfg["functions"][0].properties == {"value": {"type": "boolean", "description": ""}}
    assert cfg["functions"][0].required == ["value"]
    # Authored entry text: the LLM must not speak over it.
    assert cfg["respond_immediately"] is False


def test_flow_role_message_is_inherited_and_overridable():
    spec = FlowSpec(
        id=uuid.uuid4(),
        version=1,
        entry="a",
        role_message="FLOW PERSONA",
        nodes=[
            FlowNode(
                name="a",
                task_messages=[Message(content="x")],
                functions=[
                    FunctionSpec(
                        name="f",
                        description="d",
                        handler="echo",
                        config={"route": "ok"},
                        routes={"ok": "b"},
                    )
                ],
            ),
            FlowNode(name="b", task_messages=[Message(content="y")], role_message="NODE PERSONA"),
        ],
    )
    bound = bind_flow(spec, handlers=_handlers())
    assert bound.configs["a"]["role_message"] == "FLOW PERSONA"
    assert bound.configs["b"]["role_message"] == "NODE PERSONA"


async def test_handler_data_merges_and_the_target_is_rendered():
    bound = bind_flow(
        _spec({"route": "ok", "public_note": "hi"}, {"ok": "b"}),
        handlers=_handlers(),
    )
    fm = FM()
    public, node = await bound.initial_node()["functions"][0].handler({"value": True}, fm)
    assert public == {"shown": "hi"}
    assert fm.state["session"]["seen"] is True
    assert node["task_messages"][0]["content"] == "done True"


async def test_rendering_the_target_does_not_mutate_the_shared_config():
    """Compiled nodes are shared across every caller — render_node deep-copies."""
    bound = bind_flow(
        _spec({"route": "ok"}, {"ok": "b"}),
        handlers=_handlers(),
    )
    await bound.initial_node()["functions"][0].handler({"value": True}, FM())
    assert bound.configs["b"]["task_messages"][0]["content"] == "done ${seen}"


async def test_on_enter_runs_before_the_target_is_rendered():
    """The whole point of on_enter: the fetched value must already be in session
    when the target's spoken text is interpolated."""

    async def fetch(ctx: HandlerContext) -> HandlerResult:
        return HandlerResult(route="ignored", data={"fetched": "שלום מהמקור"})

    spec = _spec(
        {"route": "ok"},
        {"ok": "b"},
        target_extra={
            "pre_actions": [ActionSpec(type=ActionType.tts_say, text="${fetched}")],
            "on_enter": EnterSpec(handler="fetch"),
        },
    )
    bound = bind_flow(spec, handlers=_handlers(fetch=fetch))
    fm = FM()
    _, node = await bound.initial_node()["functions"][0].handler({"value": True}, fm)
    assert node["pre_actions"][0]["text"] == "שלום מהמקור"
    assert fm.state["session"]["fetched"] == "שלום מהמקור"


async def test_on_enter_refetches_on_every_entry():
    """A self-loop must see fresh data, not the first entry's."""

    calls = itertools.count(1)

    async def fetch(ctx: HandlerContext) -> HandlerResult:
        return HandlerResult(route="ignored", data={"fetched": f"call {next(calls)}"})

    spec = _spec(
        {"route": "ok"},
        {"ok": "b"},
        target_extra={"on_enter": EnterSpec(handler="fetch")},
    )
    bound = bind_flow(spec, handlers=_handlers(fetch=fetch))
    fm = FM()
    handler = bound.initial_node()["functions"][0].handler
    await handler({"value": True}, fm)
    await handler({"value": True}, fm)
    assert fm.state["session"]["fetched"] == "call 2"


async def test_unmapped_route_raises():
    bound = bind_flow(
        _spec({"route": "nope"}, {"ok": "b"}),
        handlers=_handlers(),
    )
    with pytest.raises(ValueError, match="unmapped route"):
        await bound.initial_node()["functions"][0].handler({}, FM())


def test_missing_handler_key_fails_at_bind_time_not_mid_call():
    spec = FlowSpec(
        id=uuid.uuid4(),
        version=1,
        entry="a",
        nodes=[
            FlowNode(
                name="a",
                task_messages=[Message(content="x")],
                functions=[
                    FunctionSpec(name="f", description="d", handler="ghost", routes={"ok": "a"})
                ],
            )
        ],
    )
    with pytest.raises(KeyError):
        bind_flow(spec, handlers=_handlers())


def test_terminal_node_with_pre_actions_keeps_responding_immediately():
    """The end-node hangup trap, carried over from #16's compiler.

    pipecat treats respond_immediately=False as "skip the LLMRunFrame and defer
    post_actions". On a node carrying end_conversation that defers the hangup to
    a BotStoppedSpeakingFrame which only fires when no action is in flight — with
    a tts_say pre-action still counted as ongoing the hangup can be dropped and
    the call left open.
    """
    spec = FlowSpec(
        id=uuid.uuid4(),
        version=1,
        entry="a",
        nodes=[
            FlowNode(
                name="a",
                task_messages=[Message(content="say goodbye")],
                pre_actions=[ActionSpec(type=ActionType.tts_say, text="להתראות")],
                post_actions=[ActionSpec(type=ActionType.end_conversation)],
            )
        ],
    )
    cfg = bind_flow(spec, handlers=_handlers()).initial_node()
    assert cfg.get("respond_immediately") is not False
    assert cfg["post_actions"] == [{"type": "end_conversation"}]


class _Task:
    def __init__(self):
        self.frames: list = []

    async def queue_frame(self, frame):
        self.frames.append(frame)


class SpeakingFM(FM):
    def __init__(self):
        super().__init__()
        self.task = _Task()


async def test_a_handler_that_returns_at_once_says_nothing():
    """The default must stay silent — a filler before an instant route decision
    is the detached, bot-sounding kind."""
    bound = bind_flow(_spec({"route": "ok"}, {"ok": "b"}), handlers=_handlers())
    fm = SpeakingFM()
    await bound.initial_node()["functions"][0].handler({"value": True}, fm)

    assert fm.task.frames == []


async def test_say_while_is_spoken_before_the_handler_runs_and_varies():
    """One line spoken verbatim on every call is what makes a caller decide they
    are talking to a machine; these bypass the model, so the persona's
    anti-repetition rule cannot reach them."""
    spec = _spec({"route": "ok"}, {"ok": "b"})
    spec.nodes[0].functions[0].say_while = ["רגע, בודקת", "עוד שנייה"]
    bound = bind_flow(spec, handlers=_handlers())
    fm = SpeakingFM()

    for _ in range(3):
        await bound.initial_node()["functions"][0].handler({"value": True}, fm)

    assert [f.text for f in fm.task.frames] == ["רגע, בודקת", "עוד שנייה", "רגע, בודקת"]


async def test_the_rotation_is_per_call_not_shared_between_callers():
    """A bound flow is shared by every caller in flight; a closure counter would
    hand the second caller line 2 as their opener."""
    spec = _spec({"route": "ok"}, {"ok": "b"})
    spec.nodes[0].functions[0].say_while = ["first", "second"]
    bound = bind_flow(spec, handlers=_handlers())

    caller_a, caller_b = SpeakingFM(), SpeakingFM()
    await bound.initial_node()["functions"][0].handler({"value": True}, caller_a)
    await bound.initial_node()["functions"][0].handler({"value": True}, caller_b)

    assert [f.text for f in caller_b.task.frames] == ["first"]
