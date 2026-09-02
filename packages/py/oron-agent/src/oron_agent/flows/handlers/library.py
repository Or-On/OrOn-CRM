"""The generic handler refs every flow shares.

A handler earns its place only when the route depends on something the LLM does
not have or should not be trusted with — a lookup result, an attempt counter,
list-index validation, paging state. Every other branch is ``route_by``, which
needs no Python per flow, ever.

Each handler validates its ``ctx.config`` with its own Pydantic model, so a
malformed flow fails loudly rather than mid-call.
"""

from typing import Any

from oron_flows.components.library.basic import CollectRoute, ConverseExit
from pydantic import BaseModel

from oron_agent.flows.runtime import Handler, HandlerContext, HandlerResult

ERROR_ROUTE = "error"


def _key(value: Any) -> str:
    """Config mappings are JSON, so their keys are strings; booleans must
    lower-case to match ``true``/``false`` rather than Python's ``True``."""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


class GotoConfig(BaseModel):
    route: str


async def _goto(ctx: HandlerContext) -> HandlerResult:
    return HandlerResult(route=GotoConfig(**ctx.config).route, data={})


class RouteByConfig(BaseModel):
    arg: str
    on: dict[str, str]
    sets: str | None = None


async def _route_by(ctx: HandlerContext) -> HandlerResult:
    cfg = RouteByConfig(**ctx.config)
    if cfg.arg not in ctx.args or ctx.args[cfg.arg] is None:
        return HandlerResult(route=ERROR_ROUTE, data={})
    value = ctx.args[cfg.arg]
    route = cfg.on.get(_key(value))
    if route is None:
        return HandlerResult(route=ERROR_ROUTE, data={})
    return HandlerResult(route=route, data={cfg.sets: value} if cfg.sets else {})


class CollectGateConfig(BaseModel):
    required: list[str]
    reasks: dict[str, str]
    attempts_var: str
    reask_var: str
    max_attempts: int


async def _collect_gate(ctx: HandlerContext) -> HandlerResult:
    """Let the flow move only once every required value is in hand.

    The counter lives here rather than in the model because the model is the
    thing being counted: asked whether it has already tried twice, it guesses.
    """
    cfg = CollectGateConfig(**ctx.config)
    session = ctx.state.get("session", {})
    captured = {k: v for k, v in ctx.args.items() if v not in (None, "")}
    # Session as well as this turn: the repair turn asks only for the gap, so the
    # model answers with only the gap, and a value banked on an earlier attempt
    # never appears in these args again.
    missing = [
        name for name in cfg.required if name not in captured and session.get(name) in (None, "")
    ]

    if not missing:
        # Reset, so a later collecting step that reuses the counter name — or a
        # caller who succeeds after failing once — starts clean.
        return HandlerResult(route=ConverseExit.done, data={**captured, cfg.attempts_var: 0})

    # Whatever WAS captured is kept, so the repair turn asks only for the gap.
    attempts = session.get(cfg.attempts_var, 0) + 1
    data = {**captured, cfg.attempts_var: attempts}
    if attempts >= cfg.max_attempts:
        return HandlerResult(route=ConverseExit.exhausted, data=data)
    return HandlerResult(
        route=CollectRoute.retry,
        data={**data, cfg.reask_var: " ".join(cfg.reasks[name] for name in missing)},
    )


def standard_handlers() -> dict[str, Handler]:
    """The registry every flow gets. Injected at the edge, never a global."""
    return {"goto": _goto, "route_by": _route_by, "collect_gate": _collect_gate}
