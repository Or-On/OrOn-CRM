"""Bind a stored FlowSpec into live pipecat NodeConfigs.

Because ``FlowNode`` already mirrors ``NodeConfig`` field for field, binding only
has to (1) resolve each ``handler`` key to a registered callable, (2) close over
the node table so a route becomes the target's config, and (3) await the target's
``on_enter`` handler before rendering it.

Step 3 is the seam that makes dynamic data work: it runs after the calling
handler's ``data`` is merged and before ``render_node`` interpolates, so a freshly
fetched value is spoken on this very entry.

Nothing here knows about components, appointments or Hebrew.
"""

from collections.abc import Awaitable, Callable
from typing import Any

from oron_flows.graph import FlowSpec
from oron_flows.node import FlowNode, FunctionSpec
from pipecat.flows import FlowsFunctionSchema, NodeConfig
from pipecat.frames.frames import TTSSpeakFrame
from pydantic import BaseModel, ConfigDict

from oron_agent.flows.render import render_node
from oron_agent.flows.runtime import Handler, HandlerContext, HandlerRegistry

RuntimeFunctionFactory = Callable[[str, dict[str, NodeConfig]], FlowsFunctionSchema]


class EnterHandler(BaseModel):
    """A node's on_enter handler, resolved to a callable at bind time."""

    model_config = ConfigDict(arbitrary_types_allowed=True)
    run: Handler
    config: dict[str, Any]


class BoundFlow(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    spec: FlowSpec
    configs: dict[str, Any]

    def initial_node(self) -> NodeConfig:
        # Rendered like any transition target. Skipping it spoke `${var}` aloud:
        # every other node reaches TTS through _bind_function's render_node, the
        # entry node is the one that does not, and it is where a greeting's
        # ${contact_name} lives.
        return render_node(self.configs[self.spec.entry], {})


def _bind_function(
    fn: FunctionSpec,
    handlers: HandlerRegistry,
    configs: dict[str, NodeConfig],
    enters: dict[str, EnterHandler],
    action_guard: Callable[..., Awaitable[Any]] | None = None,
) -> FlowsFunctionSchema:
    properties: dict[str, dict] = {}
    required: list[str] = []
    for p in fn.parameters:
        prop: dict = {"type": p.type.value, "description": p.description}
        if p.enum is not None:
            prop["enum"] = p.enum
        properties[p.name] = prop
        if p.required:
            required.append(p.name)

    handler = handlers.handlers[fn.handler]  # KeyError -> bind time, not mid-call
    # Bound as locals so the per-call closure holds these rather than the whole
    # FunctionSpec, whose parameters were already consumed into the schema above.
    name, handler_key, routes, config = fn.name, fn.handler, fn.routes, fn.config
    say_while = fn.say_while

    async def execute(args: dict, flow_manager) -> tuple[Any, NodeConfig]:
        if say_while:
            # Counter in per-call state, not the closure: a bound flow is shared
            # by every caller in flight, so a closure would rotate across calls
            # and hand one caller line 2 as their first.
            spoken = flow_manager.state.setdefault("_say_while", {})
            turn = spoken.get(name, 0)
            spoken[name] = turn + 1
            await flow_manager.task.queue_frame(TTSSpeakFrame(say_while[turn % len(say_while)]))
        ctx = HandlerContext(args=args, state=flow_manager.state, config=config)
        result = await handler(ctx)
        if result.route not in routes:
            raise ValueError(
                f"handler '{handler_key}' returned unmapped route '{result.route}' "
                f"(function '{name}' maps {sorted(routes)})"
            )
        session = flow_manager.state.setdefault("session", {})
        session.update(result.data)

        target_name = routes[result.route]
        # Entry data first, so the target's ${vars} interpolate against it. The
        # entry handler's route is ignored: nothing chose to arrive here.
        if (enter := enters.get(target_name)) is not None:
            entered = await enter.run(HandlerContext(state=flow_manager.state, config=enter.config))
            session.update(entered.data)

        # render_node copies: compiled nodes are shared across every caller, so
        # interpolating in place would mutate shared config.
        return result.public, render_node(configs[target_name], session)

    async def wrapper(args: dict, flow_manager) -> tuple[Any, NodeConfig]:
        if action_guard is not None:
            return await action_guard(execute, args, flow_manager)
        return await execute(args, flow_manager)

    return FlowsFunctionSchema(
        name=fn.name,
        description=fn.description,
        properties=properties,
        required=required,
        handler=wrapper,
        cancel_on_interruption=action_guard is not None,
    )


def _build(
    spec: FlowSpec,
    node: FlowNode,
    configs: dict[str, NodeConfig],
    handlers: HandlerRegistry,
    enters: dict[str, EnterHandler],
    action_guard: Callable[..., Awaitable[Any]] | None = None,
    runtime_function_factories: tuple[RuntimeFunctionFactory, ...] = (),
) -> NodeConfig:
    config: NodeConfig = {
        "name": node.name,
        "task_messages": [m.model_dump(mode="json") for m in node.task_messages]
        or [{"role": "system", "content": ""}],
    }
    role = node.role_message or spec.role_message
    if role:
        config["role_message"] = role
    if node.pre_actions:
        # pyrefly: ignore[bad-assignment]  # model_dump yields the ActionConfig shape at runtime
        config["pre_actions"] = [
            a.model_dump(exclude_none=True, mode="json") for a in node.pre_actions
        ]
    if node.post_actions:
        # pyrefly: ignore[bad-assignment]  # model_dump yields the ActionConfig shape at runtime
        config["post_actions"] = [
            a.model_dump(exclude_none=True, mode="json") for a in node.post_actions
        ]
    functions: list[Any] = []
    if node.functions:
        functions.extend(
            _bind_function(fn, handlers, configs, enters, action_guard) for fn in node.functions
        )
    if not node.is_terminal:
        functions.extend(factory(node.name, configs) for factory in runtime_function_factories)
    if functions:
        config["functions"] = functions

    if node.respond_immediately is not None:
        config["respond_immediately"] = node.respond_immediately
    elif node.pre_actions and not node.is_terminal:
        # Authored entry text: the LLM must not speak over it. Deliberately NOT
        # applied to a terminal node, whose deferred end_conversation can be dropped.
        config["respond_immediately"] = False
    return config


def bind_flow(
    spec: FlowSpec,
    *,
    handlers: HandlerRegistry,
    action_guard: Callable[..., Awaitable[Any]] | None = None,
    runtime_function_factories: tuple[RuntimeFunctionFactory, ...] = (),
) -> BoundFlow:
    # Resolved here so an unknown on_enter handler is a bind-time KeyError, the
    # same as an unknown function handler.
    enters = {
        n.name: EnterHandler(run=handlers.handlers[n.on_enter.handler], config=n.on_enter.config)
        for n in spec.nodes
        if n.on_enter is not None
    }
    configs: dict[str, NodeConfig] = {}
    # Handlers close over `configs`, fully populated before any handler runs, so
    # forward references resolve.
    for node in spec.nodes:
        configs[node.name] = _build(
            spec,
            node,
            configs,
            handlers,
            enters,
            action_guard,
            runtime_function_factories,
        )
    return BoundFlow(spec=spec, configs=configs)
