from collections.abc import Awaitable, Callable
from typing import Any

from loguru import logger
from oron_flows.compose import Composition, expand
from oron_flows.graph import FlowSpec
from pipecat.flows import NodeConfig

from oron_agent.flows.binder import bind_flow
from oron_agent.flows.greeting import create_greeting_node
from oron_agent.flows.handlers.library import standard_handlers
from oron_agent.flows.runtime import HandlerRegistry

__all__ = ["initial_node_from_composition", "initial_node_from_spec"]


def _with_safe_entry_opener(node: NodeConfig, language: str) -> NodeConfig:
    """Ensure a stored flow never asks the LLM to invent the call opener."""
    terminal = any(
        action.get("type") in {"end_conversation", "transfer"}
        for action in node.get("post_actions", [])
    )
    if terminal or node.get("pre_actions") or node.get("respond_immediately") is False:
        return node
    fallback = create_greeting_node(language)
    node["pre_actions"] = fallback["pre_actions"]
    node["respond_immediately"] = False
    return node


def initial_node_from_spec(
    spec: FlowSpec, *, action_guard: Callable[..., Awaitable[Any]] | None = None
) -> NodeConfig:
    """Entry NodeConfig for a stored spec, or a localized greeting on any failure —
    a bad flow must never kill a call."""
    try:
        node = bind_flow(
            spec, handlers=HandlerRegistry(handlers=standard_handlers()), action_guard=action_guard
        ).initial_node()
        return _with_safe_entry_opener(node, spec.language)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"flow load failed for '{spec.id}' ({e}); falling back to greeting")
        return create_greeting_node(spec.language)


def initial_node_from_composition(composition: Composition) -> NodeConfig:
    """Expand then bind. The dev path and the tests author compositions directly;
    a real call binds the spec the store already froze."""
    try:
        return initial_node_from_spec(expand(composition))
    except Exception as e:  # noqa: BLE001
        logger.warning(
            f"flow load failed for '{composition.flow.id}' ({e}); falling back to greeting"
        )
        return create_greeting_node()
