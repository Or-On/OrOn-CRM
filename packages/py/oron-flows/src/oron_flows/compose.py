"""Composition -> FlowSpec.

`expand()` is a pure function: no I/O, no pipecat, no LLM. Every component is
therefore testable by asserting the nodes it emits, which is where F4's real
coverage lives.

Wiring: a component's DEFAULT exit falls through to the next step in the list.
Every other exit must be named in `on:` — a branch's natural continuation is the
join point, not the next line in the file, so inheriting it would be a trap.
"""

import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field, SerializeAsAny, field_validator

from oron_flows.components import ComponentSpec, ExpandContext, Step, get_spec
from oron_flows.graph import FlowSpec
from oron_flows.node import FlowNode, FunctionSpec
from oron_flows.packs import INSTRUCTIONS, build_persona, load_language_pack
from oron_flows.text import render_instruction
from oron_flows.voice import FlowVoice


class FlowMeta(BaseModel):
    id: uuid.UUID
    version: int
    language: str = "he"
    name: str = ""
    """Human label for pickers and logs. Optional because a flow is identified by
    its id — this only has to be good enough to tell two of them apart, which a
    UUID is not."""


class Persona(BaseModel):
    agent_name: str
    org: str
    gender: Literal["female", "male", "neutral"] = "female"
    pronunciations: dict[str, str] = Field(default_factory=dict)
    """Written form -> spoken form, for brand and foreign names TTS would mangle.
    A tenant's vocabulary, so it is authored per flow — never in a language pack."""
    voice: FlowVoice = Field(default_factory=FlowVoice)
    """Vendor, voice and whether to point Hebrew. Beside the pronunciations
    because both are the same question — how this flow should sound — and both
    are the author's to answer, not the deployment's."""


class GlobalEdge(BaseModel):
    """An escape hatch available from every non-terminal node: without it there is
    no way out of a node except its own exits."""

    id: str
    to: str
    when: str
    """Natural-language condition; becomes the function's description, which is
    what the model selects on."""


class Composition(BaseModel):
    flow: FlowMeta
    persona: Persona | None = None
    steps: list[SerializeAsAny[Step]] = Field(default_factory=list)
    # SerializeAsAny: without it, `model_dump` serialises each step through the
    # base `Step` schema and silently drops subclass fields (`say`, `then`), so a
    # composition would not round-trip through JSON. SerializeAsAny dumps each
    # instance by its own runtime type.
    nodes: list[FlowNode] = Field(default_factory=list)
    """Raw-node escape hatch. Never needed for an appointment flow, but it means
    no flow is ever blocked on a framework change."""
    globals: list[GlobalEdge] = Field(default_factory=list)

    @field_validator("steps", mode="before")
    @classmethod
    def _hydrate_steps(cls, value: Any) -> Any:
        """Turn stored dicts back into their concrete step models.

        Authored-in-Python steps are already concrete and pass through; JSON
        loaded from the store arrives as dicts and is routed through the
        registry, so an unknown component or a stray property fails here.
        """
        if not isinstance(value, list):
            return value
        out = []
        for item in value:
            if isinstance(item, Step):
                out.append(item)
            elif isinstance(item, dict):
                out.append(get_spec(item["use"]).model(**item))
            else:
                out.append(item)
        return out


def _resolve_exits(step: Step, spec: ComponentSpec, next_step_id: str | None) -> dict[str, str]:
    exits: dict[str, str] = {}
    for exit_ in spec.exits:
        if exit_.name in step.on:
            exits[exit_.name] = step.on[exit_.name]
            continue
        if exit_.optional:
            continue  # only some configurations can reach it; expand enforces those
        if exit_.name != spec.default_exit:
            raise ValueError(
                f"step '{step.id}' must route exit '{exit_.name}' "
                f"({exit_.description or 'no description'}) — only the default "
                "exit falls through to the next step"
            )
        if next_step_id is None:
            raise ValueError(
                f"step '{step.id}' is last, so its default exit '{exit_.name}' has "
                "nowhere to fall through to; name a target in `on:`"
            )
        exits[exit_.name] = next_step_id
    declared = {e.name for e in spec.exits}
    unknown = set(step.on) - declared
    if unknown:
        raise ValueError(
            f"step '{step.id}' routes unknown exit(s) {sorted(unknown)}; "
            f"component '{spec.name}' declares {sorted(declared)}"
        )
    return exits


def _attach_globals(nodes: list[FlowNode], globals_: list[GlobalEdge]) -> None:
    """Every non-terminal node gets one goto function per global.

    Terminal nodes are skipped: they end or hand off the call, so there is no LLM
    turn in which a transition could be chosen.
    """
    if not globals_:
        return
    known = {n.name for n in nodes}
    for g in globals_:
        if g.to not in known:
            raise ValueError(f"global '{g.id}' points at unknown node '{g.to}'")
    for node in nodes:
        if node.is_terminal:
            continue
        taken = {f.name for f in node.functions}
        for g in globals_:
            name = f"global_{g.id}"
            if name in taken:
                raise ValueError(
                    f"global '{g.id}' collides with function '{name}' on '{node.name}'"
                )
            taken.add(name)
            node.functions.append(
                FunctionSpec(
                    name=name,
                    description=render_instruction(INSTRUCTIONS["global_transition"], when=g.when),
                    parameters=[],
                    handler="goto",
                    config={"route": g.id},
                    routes={g.id: g.to},
                )
            )


def expand(composition: Composition) -> FlowSpec:
    ids = [s.id for s in composition.steps]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate step id in composition")

    pack = load_language_pack(composition.flow.language)
    persona_text = (
        build_persona(
            pack,
            agent_name=composition.persona.agent_name,
            org=composition.persona.org,
            gender=composition.persona.gender,
            pronunciations=composition.persona.pronunciations,
        )
        if composition.persona
        else None
    )

    nodes: list[FlowNode] = []
    for index, step in enumerate(composition.steps):
        spec = get_spec(step.use)
        ctx = ExpandContext(
            language=composition.flow.language,
            exits=_resolve_exits(step, spec, ids[index + 1] if index + 1 < len(ids) else None),
            instructions=INSTRUCTIONS,
            persona=persona_text,
            pack=pack,
        )
        nodes.extend(spec.expand(step, ctx))

    nodes.extend(composition.nodes)
    _attach_globals(nodes, composition.globals)

    # FlowSpec's validators prove every route resolves and every node is
    # reachable, so a mistyped `on:` fails here rather than mid-call.
    return FlowSpec(
        id=composition.flow.id,
        version=composition.flow.version,
        entry=composition.steps[0].id if composition.steps else composition.nodes[0].name,
        language=composition.flow.language,
        persona_gender=composition.persona.gender if composition.persona else "neutral",
        role_message=persona_text,
        # Also on the spec, not only rendered into the persona prompt: the
        # scripted `say` lines never reach the model, so the TTS path needs the
        # authored forms itself. Persona is optional, and a flow without one has
        # no authored vocabulary either.
        pronunciations=composition.persona.pronunciations if composition.persona else {},
        voice=composition.persona.voice if composition.persona else FlowVoice(),
        nodes=nodes,
    )
