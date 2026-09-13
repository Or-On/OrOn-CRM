"""Tenant runtime flow predicates exclude unowned development fixtures."""

import uuid
from types import SimpleNamespace

from oron_flows.store import GLOBAL_TENANT
from oron_tenancy.flow_store import _flow_spec_from_row, _visible_to
from sqlalchemy.dialects import postgresql


def _sql(tenant_id: str) -> tuple[str, dict[str, object]]:
    compiled = _visible_to(tenant_id).compile(
        dialect=postgresql.dialect(), compile_kwargs={"render_postcompile": True}
    )
    return str(compiled), compiled.params


def test_tenant_visibility_never_includes_null_tenant_flows() -> None:
    tenant_id = uuid.uuid4()

    statement, parameters = _sql(str(tenant_id))

    assert "IS NULL" not in statement
    assert tenant_id in parameters.values()


def test_global_fixture_visibility_requires_the_explicit_non_runtime_key() -> None:
    statement, _ = _sql(GLOBAL_TENANT)

    assert "IS NULL" in statement


def test_legacy_frozen_flow_hydrates_structured_persona_gender_from_source() -> None:
    flow_id = uuid.uuid4()
    row = SimpleNamespace(
        spec={
            "id": str(flow_id),
            "version": 1,
            "entry": "start",
            "nodes": [{"name": "start"}],
        },
        source={"persona": {"gender": "male"}},
    )

    loaded = _flow_spec_from_row(row)  # type: ignore[arg-type]

    assert loaded.persona_gender == "male"


def test_legacy_frozen_flow_defaults_to_neutral_when_source_has_no_persona() -> None:
    row = SimpleNamespace(
        spec={
            "id": str(uuid.uuid4()),
            "version": 1,
            "entry": "start",
            "nodes": [{"name": "start"}],
        },
        source={},
    )

    assert _flow_spec_from_row(row).persona_gender == "neutral"  # type: ignore[arg-type]
