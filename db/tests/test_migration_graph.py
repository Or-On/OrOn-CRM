import json
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory


def test_migration_graph_has_exactly_one_head() -> None:
    config_path = Path(__file__).parents[1] / "alembic" / "alembic.ini"
    manifest_path = Path(__file__).parents[1] / "contracts" / "schema-manifest.json"
    scripts = ScriptDirectory.from_config(Config(config_path))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    assert scripts.get_bases() == ["0001"]
    assert scripts.get_heads() == [manifest["alembic_head"]]


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
    assert revisions["cebe5f87cf18"].down_revision == "2ef8ecd10c3d"
    assert revisions["f5e8b540dfeb"].down_revision == "cebe5f87cf18"
    assert revisions["e24340ce81c8"].down_revision == "b56eb0a0aca1"
    assert revisions["315710614ae5"].down_revision == "e24340ce81c8"
    # Preserve the reviewed baseline's entire ancestry and original merge,
    # followed only by the explicit serial remediation revisions below.
    assert len(revisions) == 164
    assert revisions["f3a8c2d91750"].down_revision == "f2c7a9d41860"
    assert revisions["f2c7a9d41860"].down_revision == "e6a91c4f208b"
    assert revisions["f0a61d9e82c4"].down_revision == "e9c5b8d2a401"
    assert revisions["b162a7e4d903"].down_revision == "f0a61d9e82c4"
    assert revisions["c8e71b4a209d"].down_revision == "b162a7e4d903"
    assert revisions["d7b80a4c913e"].down_revision == "c8e71b4a209d"
    remediation_chain = (
        "9b2e7a4c6d18",
        "a14d0c8e2b77",
        "b672f9a6c310",
        "c830d71e2f49",
        "d53170e04c62",
        "e6f128c7a904",
        "f7d239a8b105",
        "a8e340b9c206",
        "b9c581d2047e",
        "c0d692e3158f",
        "d1e7a304269b",
        "e2f8b415370c",
        "e3f9c526481d",
        "e4fad637592e",
        "e50be7486a3f",
        "e60cf8597b40",
        "e71df96a8c51",
        "e82e0a7b9d62",
        "e93f1b8c0e73",
        "ea402c9d1f84",
        "eb513dae2095",
        "ec624ebf31a6",
        "ed735fc042b7",
        "ee8460d153c8",
        "ef9751e264d9",
        "f0a862f375ea",
        "f1b9730486fb",
        "f2ca8415970c",
        "f3db9526a81d",
        "f4ec0637b92e",
        "f5fd1748ca3f",
        "f60e2859db4a",
        "f71f396aec5b",
        "f82a407bfd6c",
        "f93b518c0e7d",
        "fa4c629d1f8e",
        "fb5d740e2a9f",
        "fc6e851f3ba0",
        "7c91e5a2b640",
        "8d32f4a91c70",
        "9e43a5b02d81",
        "af54b6c13e92",
    )
    for previous, current in zip(remediation_chain, remediation_chain[1:], strict=False):
        assert revisions[current].down_revision == previous
