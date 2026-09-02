"""The one extension point a flow has: a named, typed handler.

A handler is whatever a flow cannot decide for itself — a lookup, an attempt
counter, list-index validation. It is reached two ways, and only two: the model
calls a function (``FunctionSpec.handler``), or a node is entered
(``EnterSpec.handler``). Both arrive here; only the first uses ``route``.
"""

from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import BaseModel, ConfigDict


class HandlerResult(BaseModel):
    route: str
    """Which of the function's ``routes`` to take. Ignored on node entry —
    nothing chose to arrive there."""
    data: dict[str, Any] = {}
    """Merged into the session, so a fetched value is spoken on this entry."""
    public: dict[str, Any] | None = None


class HandlerContext(BaseModel):
    args: dict[str, Any] = {}
    """The model's function arguments; empty on node entry."""
    state: dict[str, Any]
    config: dict[str, Any] = {}
    """The ``config`` block — what makes a handler generic. Each handler parses
    it with its own Pydantic model."""


Handler = Callable[[HandlerContext], Awaitable[HandlerResult]]


class HandlerRegistry(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    handlers: dict[str, Handler]
