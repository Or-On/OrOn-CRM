from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory


def test_migration_graph_has_exactly_one_head() -> None:
    config_path = Path(__file__).parents[1] / "alembic" / "alembic.ini"
    scripts = ScriptDirectory.from_config(Config(config_path))

    assert scripts.get_bases() == ["0001"]
    assert scripts.get_heads() == ["2ef8ecd10c3d"]


def test_complete_oron_lineage_is_preserved() -> None:
    config_path = Path(__file__).parents[1] / "alembic" / "alembic.ini"
    scripts = ScriptDirectory.from_config(Config(config_path))
    revisions = {revision.revision: revision for revision in scripts.walk_revisions()}

    expected = {
        "0001",
        "0002",
        "0003",
        "0004",
        "0005",
        "0006",
        "0007",
        "0008",
        "0009",
        "0010",
        "0011",
        "8eda5976c920",
        "46a2cce29f18",
        "7433e45e0d29",
        "f596c72044b0",
        "c80d93f1c8be",
        "3b4a1c5307b4",
        "ea9aef9b2d14",
        "0e01a2f68295",
        "b38ef3c19979",
        "8aa960fd77ec",
        "a41d2f6c2925",
    }
    assert expected < set(revisions)
    assert revisions["0001"].down_revision is None
    assert set(revisions["8aa960fd77ec"]._normalized_down_revisions) == {
        "0e01a2f68295",
        "b38ef3c19979",
    }
    assert revisions["34376836baf5"].down_revision == "a41d2f6c2925"
    assert revisions["a929e3f55c7a"].down_revision == "34376836baf5"
    assert revisions["2ef8ecd10c3d"].down_revision == "a929e3f55c7a"
