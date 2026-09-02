"""The typed authoring surface.

A flow author writes concrete Step subclasses — `Inform(id=..., say=...)` — so a
misspelled property is a type error at author time, not a KeyError mid-call.
Exits are StrEnum members for the same reason.
"""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


def step_field(
    default: Any = ...,
    *,
    description: str,
    options: list[str] | None = None,
    **kwargs: Any,
):
    """A component property. `description` is LLM-readable and is surfaced in the
    generated ComponentSpec, so treat it as production documentation."""
    extra: dict[str, Any] = {}
    if options is not None:
        extra["options"] = options
    return Field(default, description=description, json_schema_extra=extra, **kwargs)


class Step(BaseModel):
    """Base for every component's authoring model."""

    model_config = ConfigDict(extra="forbid")
    id: str
    use: str
    on: dict[str, str] = Field(default_factory=dict)
    """Exit name -> target step id. Only the default exit may be omitted."""
