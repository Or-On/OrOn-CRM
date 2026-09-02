import pytest
from oron_flows.components import Step, build_spec, get_spec, step_field
from oron_flows.components.library import basic  # noqa: F401 — registers
from oron_flows.node import FlowNode


class Demo(Step):
    use: str = "demo_component"
    ask: str = step_field(..., description="The question.")
    sets: str | None = step_field(None, description="Session var.")
    retries: int = step_field(3, description="How many times to re-ask.")
    mapping: dict[str, str] = step_field(default_factory=dict, description="A mapping.")


def test_properties_are_derived_from_the_model_not_hand_written():
    props = {p.name: p for p in build_spec(Demo)}
    assert set(props) == {"ask", "sets", "retries", "mapping"}
    assert props["ask"].required is True
    assert props["sets"].required is False
    assert props["retries"].type == "number"
    assert props["mapping"].type == "mapping"
    assert props["sets"].type == "string"  # `str | None` unwraps to string


def test_a_default_is_the_value_you_actually_get_when_you_omit_the_property():
    """Three states an author must be able to tell apart: required (no default),
    defaults to null, and defaults to an empty container built by a factory."""
    props = {p.name: p for p in build_spec(Demo)}
    assert (props["ask"].required, props["ask"].default) == (True, None)
    assert (props["sets"].required, props["sets"].default) == (False, None)
    assert props["retries"].default == 3
    assert props["mapping"].default == {}  # not None — the factory is called


def test_a_required_property_cannot_also_carry_a_default():
    from oron_flows.components._spec import PropertySpec

    with pytest.raises(ValueError, match="required"):
        PropertySpec(name="p", description="d", required=True, default="x")


def test_base_fields_are_not_properties():
    assert {"id", "use", "on"}.isdisjoint({p.name for p in build_spec(Demo)})


def test_a_property_without_a_description_is_rejected():
    class Bad(Step):
        use: str = "bad_component"
        thing: str = step_field(..., description="")

    with pytest.raises(ValueError):
        build_spec(Bad)


def test_registering_twice_is_rejected():
    from oron_flows.components._spec import register_component

    with pytest.raises(ValueError, match="Duplicate"):
        register_component(
            model=type(get_spec("inform").model.__name__, (get_spec("inform").model,), {}),
            description="d",
            expand=lambda s, c: [FlowNode(name=s.id)],
        )


def test_a_registered_component_carries_generated_properties():
    spec = get_spec("inform")
    assert {p.name for p in spec.properties} == {"say"}
    assert spec.default_exit == "acknowledged"


def test_registered_examples_are_domain_neutral():
    """Framework code must not carry a real tenant's copy."""
    for spec in (get_spec("inform"), get_spec("announce")):
        blob = repr(spec.examples)
        assert "ברימאג" not in blob and "גילי" not in blob
