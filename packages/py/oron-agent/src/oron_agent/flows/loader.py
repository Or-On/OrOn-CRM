from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from loguru import logger
from oron_flows.compose import Composition, expand
from oron_flows.graph import FlowSpec
from oron_flows.packs import build_persona, load_language_pack
from pipecat.flows import FlowsFunctionSchema, NodeConfig

from oron_agent.flows.binder import bind_flow
from oron_agent.flows.greeting import create_greeting_node
from oron_agent.flows.handlers.library import standard_handlers
from oron_agent.flows.runtime import HandlerRegistry

__all__ = ["initial_node_from_composition", "initial_node_from_spec"]


def _composition_role_message(composition: Composition) -> str | None:
    persona = composition.persona
    if persona is None:
        return None
    return build_persona(
        load_language_pack(composition.flow.language),
        agent_name=persona.agent_name,
        org=persona.org,
        gender=persona.gender,
        pronunciations=persona.pronunciations,
    )


def _with_safe_entry_opener(node: NodeConfig, language: str) -> NodeConfig:
    """Give unscripted entries one model policy instead of localized canned text."""
    terminal = any(
        action.get("type") in {"end_conversation", "transfer"}
        for action in node.get("post_actions", [])
    )
    if terminal or node.get("pre_actions") or node.get("respond_immediately") is False:
        return node
    opener = create_greeting_node(language)
    node["task_messages"] = [
        *node.get("task_messages", []),
        *opener["task_messages"],
    ]
    node["respond_immediately"] = True
    return node


def initial_node_from_spec(
    spec: FlowSpec,
    *,
    action_guard: Callable[..., Awaitable[Any]] | None = None,
    call_functions: Sequence[FlowsFunctionSchema] = (),
) -> NodeConfig:
    """Entry NodeConfig for a stored spec, or a safe model opener on any failure —
    a bad flow must never kill a call.

    ``call_functions`` are the published agent's business actions for this call
    (for example lead capture). They ride on every conversing node, and on the
    recovery opener too: a malformed flow must not silently strip an agent of
    the capabilities it was published with.
    """
    try:
        node = bind_flow(
            spec,
            handlers=HandlerRegistry(handlers=standard_handlers()),
            action_guard=action_guard,
            call_functions=call_functions,
        ).initial_node()
        return _with_safe_entry_opener(node, spec.language)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"flow load failed for '{spec.id}' ({e}); falling back to greeting")
        # Recovery must retain the stored role. A generic greeting without the
        # authoritative role can make a tenant call sound like the provider's
        # demo assistant after a single malformed node or missing handler.
        fallback = create_greeting_node(spec.language, role_message=spec.role_message)
        if call_functions:
            fallback["functions"] = [*fallback.get("functions", []), *call_functions]
        return fallback


def initial_node_from_composition(composition: Composition) -> NodeConfig:
    """Expand then bind. The dev path and the tests author compositions directly;
    a real call binds the spec the store already froze."""
    try:
        return initial_node_from_spec(expand(composition))
    except Exception as e:  # noqa: BLE001
        logger.warning(
            f"flow load failed for '{composition.flow.id}' ({e}); falling back to greeting"
        )
        return create_greeting_node(
            composition.flow.language,
            role_message=_composition_role_message(composition),
        )
