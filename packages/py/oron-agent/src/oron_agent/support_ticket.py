"""Verified support-ticket tool exposed to every conversational flow node."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from oron_common import CallContext
from pipecat.flows import FlowsFunctionSchema, NodeConfig

from oron_agent.flows.binder import RuntimeFunctionFactory
from oron_agent.flows.render import render_node


def support_ticket_function_factory(
    sessions: Any,
    context: CallContext,
    receipt_state: dict[str, Any],
    action_guard: Callable[..., Awaitable[Any]] | None = None,
) -> RuntimeFunctionFactory:
    """Create a per-call tool; caller identity comes from transport context."""

    def factory(node_name: str, configs: dict[str, NodeConfig]) -> FlowsFunctionSchema:
        async def open_ticket(args: dict, flow_manager) -> tuple[dict, NodeConfig]:
            session = flow_manager.state.setdefault("session", {})
            try:
                receipt = await sessions.open_support_ticket(
                    context,
                    subject=str(args.get("subject", "")),
                    summary=str(args.get("summary", "")),
                )
            except Exception:
                receipt = None
            if not isinstance(receipt, dict) or not receipt.get("ticketId"):
                return (
                    {
                        "success": False,
                        "instruction": "The ticket save could not be confirmed. Do not say it "
                        "was opened. Explain briefly and retry if appropriate.",
                    },
                    render_node(configs[node_name], session),
                )
            receipt_state.clear()
            receipt_state.update(receipt)
            return (
                {
                    "success": True,
                    "reference": receipt.get("reference"),
                    "instruction": "Confirm the ticket was opened and state its reference once.",
                },
                render_node(configs[node_name], session),
            )

        async def guarded(args: dict, flow_manager):
            if action_guard is not None:
                return await action_guard(open_ticket, args, flow_manager)
            return await open_ticket(args, flow_manager)

        return FlowsFunctionSchema(
            name="open_support_ticket",
            description=(
                "Open a support ticket when the caller explicitly asks for one or agrees to it. "
                "Caller identity and phone are already known from the call; never ask for them."
            ),
            properties={
                "subject": {
                    "type": "string",
                    "description": "A concise issue title in the caller's language.",
                },
                "summary": {
                    "type": "string",
                    "description": "A concise factual summary using details already provided.",
                },
            },
            required=["subject", "summary"],
            handler=guarded,
            cancel_on_interruption=action_guard is not None,
        )

    return factory
