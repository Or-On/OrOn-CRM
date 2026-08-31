from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory


def test_migration_graph_has_exactly_one_head() -> None:
    config_path = Path(__file__).parents[1] / "alembic" / "alembic.ini"
    scripts = ScriptDirectory.from_config(Config(config_path))

    assert scripts.get_heads() == ["0001_platform_foundation"]
