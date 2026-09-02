"""The catalog is a wire contract: the MCP authoring agent and any future
builder UI consume it. Changes to it must be deliberate, hence the golden file."""

import json
from pathlib import Path

import oron_flows.components.library  # noqa: F401 — import registers the components
from oron_flows.components import SPEC_VERSION, export_catalog

GOLDEN = Path(__file__).parent / "fixtures" / "catalog.json"


def test_catalog_carries_a_spec_version():
    assert export_catalog()["spec_version"] == SPEC_VERSION


def test_catalog_excludes_the_unserializable_runtime_fields():
    """`model` is a class and `expand` is a callable — neither crosses the wire."""
    payload = export_catalog()
    assert json.dumps(payload)  # must not raise
    for component in payload["components"]:
        assert "model" not in component
        assert "expand" not in component


def test_catalog_carries_what_an_author_needs_to_choose_a_component():
    by_name = {c["name"]: c for c in export_catalog()["components"]}
    converse = by_name["converse"]
    assert converse["description"]
    assert converse["default_exit"] == "done"
    assert {p["name"] for p in converse["properties"]} == {
        "task",
        "say",
        "collect",
        "max_attempts",
    }
    assert converse["examples"]


def test_catalog_matches_the_golden_file():
    """Regenerate deliberately:
    uv run python -m oron_flows.components > packages/oron-flows/tests/fixtures/catalog.json
    """
    assert export_catalog() == json.loads(GOLDEN.read_text(encoding="utf-8"))


def test_requires_cannot_name_a_property_the_editor_cannot_evaluate():
    """The console reads `requires.property` as a list. Registration is where
    that stays true — otherwise the check becomes a truthiness table that reads
    an empty mapping as present and `false` as absent, in two languages."""
    import pytest
    from oron_flows.components._spec import ExitRequires, register_component
    from oron_flows.components.library.basic import Converse, ConverseExit

    class NotAList(Converse):
        use: str = "not-a-list-probe"

    with pytest.raises(ValueError, match="must be a list"):
        register_component(
            model=NotAList,
            description="probe",
            exits=list(ConverseExit),
            expand=lambda s, c: [],
            exit_requires={ConverseExit.exhausted: ExitRequires(property="task")},
        )
