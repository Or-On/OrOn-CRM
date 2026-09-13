"""The stored flow: an entry point plus a bag of serializable nodes.

There is deliberately no separate edge model. An edge is a zero-parameter
function whose handler is ``goto``; a start node is ``respond_immediately:
true``; an end node carries an ``end_conversation`` post-action. Those belong to
the components that emit them, not to the graph.

Execution order is the graph, resolved at runtime by routes — list order never
decides what is served. Node order is preserved only so the stored graph reads
top-to-bottom like the call does.
"""

import uuid
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from oron_flows.node import FlowNode
from oron_flows.voice import FlowVoice


class FlowSpec(BaseModel):
    id: uuid.UUID
    version: int
    entry: str
    language: str = "he"
    persona_gender: Literal["female", "male", "neutral"] = "neutral"
    """Structured speaking gender for Hebrew morphology and G2P.

    It is intentionally separate from ``role_message``: a TTS processor cannot
    reliably recover grammar from prose, and guessing female was wrong for
    existing male-authored flows.
    """
    role_message: str | None = None
    """Flow-wide persona; a node's own ``role_message`` overrides it."""
    pronunciations: dict[str, str] = Field(default_factory=dict)
    """Authored written -> spoken forms. On the spec, not just in the prompt,
    because the scripted ``say`` lines never reach the model — telling it how to
    pronounce a name cannot fix a line it does not write."""
    voice: FlowVoice = Field(default_factory=FlowVoice)
    """How this flow sounds. Empty means "whatever is deployed"."""
    nodes: list[FlowNode] = Field(min_length=1)

    def node(self, name: str) -> FlowNode:
        for n in self.nodes:
            if n.name == name:
                return n
        raise KeyError(name)

    def reachable_from_entry(self) -> set[str]:
        by_name = {n.name: n for n in self.nodes}
        seen: set[str] = set()
        stack = [self.entry]
        while stack:
            current = stack.pop()
            if current in seen or current not in by_name:
                continue
            seen.add(current)
            for fn in by_name[current].functions:
                stack.extend(fn.routes.values())
        return seen

    @model_validator(mode="after")
    def _validate_graph(self) -> FlowSpec:
        names = [n.name for n in self.nodes]
        if len(names) != len(set(names)):
            raise ValueError("duplicate node name")
        known = set(names)
        if self.entry not in known:
            raise ValueError(f"entry '{self.entry}' is not a node name")
        for node in self.nodes:
            for fn in node.functions:
                for route, target in fn.routes.items():
                    if target not in known:
                        raise ValueError(
                            f"node '{node.name}' function '{fn.name}' route "
                            f"'{route}' points at unknown node '{target}'"
                        )
        orphans = known - self.reachable_from_entry()
        if orphans:
            raise ValueError(
                f"unreachable node(s) {sorted(orphans)} — nothing routes to them "
                f"from entry '{self.entry}'"
            )
        return self
