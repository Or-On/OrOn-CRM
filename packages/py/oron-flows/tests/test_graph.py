import uuid

import pytest
from oron_flows.graph import FlowSpec
from oron_flows.node import FlowNode, FunctionSpec
from pydantic import ValidationError


def _node(name: str, routes: dict[str, str] | None = None) -> FlowNode:
    return FlowNode(
        name=name,
        functions=(
            [FunctionSpec(name=f"{name}_fn", description="d", handler="goto", routes=routes)]
            if routes
            else []
        ),
    )


def test_valid_spec_builds():
    spec = FlowSpec(
        id=uuid.uuid4(), version=1, entry="a", nodes=[_node("a", {"ok": "b"}), _node("b")]
    )
    assert spec.node("b").name == "b"
    assert {n.name for n in spec.nodes} == {"a", "b"}


def test_duplicate_node_name_rejected():
    with pytest.raises(ValidationError, match="duplicate node name"):
        FlowSpec(id=uuid.uuid4(), version=1, entry="a", nodes=[_node("a"), _node("a")])


def test_entry_must_be_a_node():
    with pytest.raises(ValidationError, match="entry"):
        FlowSpec(id=uuid.uuid4(), version=1, entry="ghost", nodes=[_node("a")])


def test_route_to_unknown_node_rejected():
    with pytest.raises(ValidationError, match="unknown node"):
        FlowSpec(
            id=uuid.uuid4(), version=1, entry="a", nodes=[_node("a", {"ok": "ghost"}), _node("b")]
        )


def test_unreachable_node_rejected():
    """A terminal step placed mid-list orphans everything after it."""
    with pytest.raises(ValidationError, match="unreachable"):
        FlowSpec(
            id=uuid.uuid4(),
            version=1,
            entry="a",
            nodes=[_node("a"), _node("orphan"), _node("also_orphan")],
        )


def test_a_self_loop_does_not_confuse_reachability():
    spec = FlowSpec(
        id=uuid.uuid4(),
        version=1,
        entry="a",
        nodes=[_node("a", {"retry": "a", "ok": "b"}), _node("b")],
    )
    assert spec.reachable_from_entry() == {"a", "b"}


def test_language_defaults_to_hebrew():
    assert FlowSpec(id=uuid.uuid4(), version=1, entry="a", nodes=[_node("a")]).language == "he"
