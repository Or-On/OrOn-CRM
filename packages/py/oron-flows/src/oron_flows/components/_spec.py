"""Component specification registry.

A ComponentSpec is the serialized contract for one component: what it can be
configured with, where it can exit to, and how it expands into stored nodes. It
is what a future editor renders and what an LLM author reads.

Crucially the property list is GENERATED from the component's typed step model
(`build_spec`), never hand-declared beside it — two sources of truth drift.
"""

from collections.abc import Callable, Iterable
from enum import StrEnum
from types import UnionType
from typing import Any, Union, get_args, get_origin

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from oron_flows.components._step import Step
from oron_flows.node import FlowNode
from oron_flows.packs import LanguagePack

SPEC_VERSION = "4.0.0"
"""Bump on any breaking change to the ComponentSpec wire shape."""

_BASE_FIELDS = frozenset({"id", "use", "on"})


class ComponentPropertyType(StrEnum):
    string = "string"
    boolean = "boolean"
    number = "number"
    mapping = "mapping"
    list = "list"


class PropertySpec(BaseModel):
    name: str
    type: ComponentPropertyType = ComponentPropertyType.string
    description: str = Field(min_length=1)
    required: bool = False
    default: JsonValue = None
    """What you get if you omit the property. Meaningful only when `required` is
    False — a required property carries `None` because it has no default, which is
    a different thing from a property that defaults to null."""

    @model_validator(mode="after")
    def _required_has_no_default(self) -> PropertySpec:
        if self.required and self.default is not None:
            raise ValueError(f"property '{self.name}' is required, so it cannot carry a default")
        return self


class ExitRequires(BaseModel):
    """An exit that exists only when a list property carries the right item.

    `flag` matters as much as `property`: Converse can run out of attempts only
    when something it collects is *required*, and a list of purely optional
    values reaches the exit exactly as never as an empty one does.
    """

    property: str
    """A list-typed property on the step's model."""
    flag: str | None = None
    """An item field that must be truthy. Absent means any item will do."""


class Exit(BaseModel):
    name: str
    description: str = ""
    optional: bool = False
    """An exit only some configurations of the component can reach — Converse
    can exhaust its retries only when it collects something. `_resolve_exits`
    lets it go unrouted; the component's own expand raises when a configuration
    that CAN reach it left it unrouted. Not a relaxation of the typo guard: an
    `on:` key matching no declared exit is still rejected."""
    requires: ExitRequires | None = None
    """What the step must contain for this exit to exist at all.

    `optional` says the exit MAY go unrouted. This says whether it is there to
    route, so an editor can stop offering a port that would expand to nothing
    and strand whatever it points at."""


class ExpandContext(BaseModel):
    language: str
    exits: dict[str, str]
    """Every declared exit resolved to a target node name — computed by
    compose.expand() from `on:` plus the fall-through default."""
    instructions: dict[str, str]
    persona: str | None = None
    pack: LanguagePack


def _unwrap(annotation: Any) -> Any:
    """`str | None` -> `str`."""
    if get_origin(annotation) in (Union, UnionType):
        non_none = [a for a in get_args(annotation) if a is not type(None)]
        if len(non_none) == 1:
            return non_none[0]
    return annotation


def _property_type(annotation: Any) -> ComponentPropertyType:
    base = _unwrap(annotation)
    origin = get_origin(base) or base
    if origin is bool:
        return ComponentPropertyType.boolean
    if origin in (int, float):
        return ComponentPropertyType.number
    if origin is dict:
        return ComponentPropertyType.mapping
    if origin is list:
        return ComponentPropertyType.list
    return ComponentPropertyType.string


def build_spec(model: type[Step]) -> list[PropertySpec]:
    """Derive the property contract from the typed step model."""
    out: list[PropertySpec] = []
    for name, field in model.model_fields.items():
        if name in _BASE_FIELDS:
            continue
        out.append(
            PropertySpec(
                name=name,
                type=_property_type(field.annotation),
                description=field.description or "",
                required=field.is_required(),
                # call_default_factory: otherwise a `default_factory=dict` field
                # yields PydanticUndefined, which pydantic reads as "not provided"
                # and silently exports as null instead of {}.
                default=None
                if field.is_required()
                else field.get_default(call_default_factory=True),
            )
        )
    return out


class ComponentSpec(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    name: str
    model: type[Step]
    description: str = Field(min_length=1)
    properties: list[PropertySpec] = Field(default_factory=list)
    exits: list[Exit] = Field(default_factory=list)
    # Each component's expand takes its OWN concrete Step subclass (Inform, etc.);
    # a registry of them is heterogeneous, so the stored type is `Any` step, not
    # the base `Step` (which would reject `(Inform, ...) -> ...` by contravariance).
    expand: Callable[[Any, ExpandContext], list[FlowNode]]
    examples: list[dict] = Field(default_factory=list)
    """Domain-NEUTRAL worked examples. Never copy from a real tenant's flow."""
    default_exit: str | None = None
    """The one exit that falls through to the next step when `on:` omits it."""

    @model_validator(mode="after")
    def _default_exit_is_declared(self) -> ComponentSpec:
        names = {e.name for e in self.exits}
        if self.exits and self.default_exit not in names:
            raise ValueError(
                f"component '{self.name}' must name a default exit from {sorted(names)}"
            )
        return self


REGISTRY: dict[str, ComponentSpec] = {}


def register_component(
    *,
    model: type[Step],
    description: str,
    expand: Callable[[Any, ExpandContext], list[FlowNode]],
    exits: Iterable[StrEnum] = (),
    default_exit: StrEnum | None = None,
    exit_descriptions: dict[str, str] | None = None,
    examples: Iterable[dict] = (),
    optional_exits: Iterable[StrEnum] = (),
    exit_requires: dict[str, ExitRequires] | None = None,
) -> ComponentSpec:
    """Register a component, deriving its property contract from `model`."""
    name = model.model_fields["use"].default
    if name in REGISTRY:
        raise ValueError(f"Duplicate ComponentSpec registration for {name!r}")
    descriptions = exit_descriptions or {}
    optional = {str(e) for e in optional_exits}
    requires = exit_requires or {}
    unknown = set(requires) - {str(e) for e in exits}
    if unknown:
        raise ValueError(f"{name}: exit_requires names undeclared exit(s) {sorted(unknown)}")
    # Restricted to list properties on purpose. A general "is this truthy"
    # check over arbitrary types reads an empty mapping as present and `false`
    # as absent; narrowing the contract removes the question instead of
    # answering it in two languages.
    for req in requires.values():
        field = model.model_fields.get(req.property)
        if field is None:
            raise ValueError(f"{name}: exit_requires names unknown property {req.property!r}")
        if get_origin(field.annotation) is not list:
            raise ValueError(
                f"{name}: exit_requires property {req.property!r} must be a list, "
                f"not {field.annotation!r}"
            )
    spec = ComponentSpec(
        name=name,
        model=model,
        description=description,
        properties=build_spec(model),
        exits=[
            Exit(
                name=str(e),
                description=descriptions.get(str(e), ""),
                optional=str(e) in optional,
                requires=requires.get(str(e)),
            )
            for e in exits
        ],
        default_exit=str(default_exit) if default_exit is not None else None,
        expand=expand,
        examples=list(examples),
    )
    REGISTRY[name] = spec
    return spec


def get_spec(name: str) -> ComponentSpec:
    if name not in REGISTRY:
        raise KeyError(f"unknown component '{name}' (known: {sorted(REGISTRY)})")
    return REGISTRY[name]


def all_specs() -> list[ComponentSpec]:
    return [REGISTRY[n] for n in sorted(REGISTRY)]


# Runtime-only fields: a class and a callable. Neither survives serialization.
_WIRE_EXCLUDE = {"model", "expand"}


def export_catalog() -> dict[str, Any]:
    """The component catalog as JSON-ready data.

    Shape matches the future `/component-types` HTTP response, so a consumer can
    read a generated file today and the endpoint later without changing.
    """
    return {
        "spec_version": SPEC_VERSION,
        "components": [s.model_dump(mode="json", exclude=_WIRE_EXCLUDE) for s in all_specs()],
    }
