"""Naming every exit in `on:` must mean exactly what falling through means.

This is the invariant the canvas editor stands on. A Composition's step order
decides where a default exit falls through to, and a canvas has no step order to
show — so the editor writes every routed exit into `on:` explicitly and lets
order become presentation. That is only safe if the two spellings expand to the
same graph, which is what these assert.

If one of these ever fails, the editor is silently authoring a different flow
from the one an author would have written by hand.
"""

import uuid

from oron_flows.components import get_spec
from oron_flows.components.library import Announce, Converse, Inform
from oron_flows.compose import Composition, FlowMeta, Persona, expand
from oron_flows.seeds import SEED_COMPOSITIONS


def _flow(steps: list) -> Composition:
    return Composition(
        flow=FlowMeta(id=uuid.uuid4(), version=1, language="he"),
        persona=Persona(agent_name="נועה", org="המוקד", gender="female"),
        steps=steps,
    )


def _graph(spec) -> dict[str, dict[str, str]]:
    """Routing only: node -> function -> target. Node ids and prompts are equal
    by construction; where the call GOES is the thing at issue."""
    return {n.name: {f.name: t for f in n.functions for t in f.routes.values()} for n in spec.nodes}


def test_naming_the_default_exit_matches_falling_through():
    fell_through = _flow(
        [
            Inform(id="greet", say="שלום"),
            Announce(id="bye", then="say goodbye"),
        ]
    )
    named = _flow(
        [
            Inform(id="greet", say="שלום", on={"acknowledged": "bye"}),
            Announce(id="bye", then="say goodbye"),
        ]
    )

    assert _graph(expand(fell_through)) == _graph(expand(named))


def test_step_order_stops_mattering_once_every_exit_is_named():
    """The canvas's real claim: with explicit exits, reordering the list is a
    presentational change and nothing more."""
    steps = [
        Inform(id="greet", say="שלום", on={"acknowledged": "ask"}),
        Converse(id="ask", task="Find out why they called.", on={"done": "bye"}),
        Announce(id="bye", then="say goodbye"),
    ]
    reordered = _flow([steps[0], steps[2], steps[1]])

    # entry still comes from steps[0], which is why the editor serializes the
    # entry step first rather than trusting the canvas's node order.
    assert expand(_flow(steps)).entry == expand(reordered).entry == "greet"
    assert _graph(expand(_flow(steps))) == _graph(expand(reordered))


def test_every_seeded_flow_survives_being_made_explicit():
    """The packaged catalog is the only real corpus there is. Rewriting each
    flow the way the editor would must not change a single route."""
    for flow_id, seed in SEED_COMPOSITIONS.items():
        original = expand(seed)

        explicit = seed.model_copy(deep=True)
        for step in explicit.steps:
            # Only what the component declares as an exit may be named in `on:`.
            # A branch declares none — its targets live in `choices` — and the
            # global transitions attached to every node are not exits at all.
            declared = {e.name for e in get_spec(step.use).exits}
            for node in original.nodes:
                if node.name != step.id:
                    continue
                for fn in node.functions:
                    for exit_name, target in fn.routes.items():
                        if exit_name in declared:
                            step.on.setdefault(exit_name, target)

        assert _graph(expand(explicit)) == _graph(original), f"{flow_id} changed when made explicit"
