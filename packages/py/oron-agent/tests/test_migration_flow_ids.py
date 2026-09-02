"""The migration's backfill literal cannot import the constant it mirrors, so
nothing but this test keeps them in step."""

import importlib.util
import uuid
from pathlib import Path

from oron_flows.seeds import EXAMPLE_HE_ID

MIGRATION = Path(__file__).resolve().parents[4] / "db" / "alembic" / "versions" / "0006_flow_id.py"


def _load_migration():
    spec = importlib.util.spec_from_file_location("_m0006", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_legacy_backfill_is_the_packaged_flow():
    assert uuid.UUID(_load_migration().PACKAGED_HE_FLOW_ID) == EXAMPLE_HE_ID


def test_unknown_sentinel_is_not_a_real_flow():
    """Pre-binding sessions are backfilled 'unknown'; that must never collide
    with a flow the agent could actually run."""
    from oron_flows.seeds import SEED_COMPOSITIONS

    assert uuid.UUID(_load_migration().UNKNOWN_FLOW_ID) not in SEED_COMPOSITIONS
