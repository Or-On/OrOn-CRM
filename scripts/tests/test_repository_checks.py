from __future__ import annotations

import json
from pathlib import Path

from scripts.check_repository import (
    check_node_manifests,
    check_runtime_imports,
    check_sibling_independence,
    check_workspace_boundaries,
)


def test_rejects_prohibited_runtime_dependency(tmp_path: Path) -> None:
    package = tmp_path / "apps" / "web"
    package.mkdir(parents=True)
    (package / "package.json").write_text(
        json.dumps({"dependencies": {"firebase": "1.0.0"}}), encoding="utf-8"
    )

    assert "prohibited runtime dependency firebase" in check_node_manifests(tmp_path)[0]


def test_allows_audit_text_and_importer_sqlite(tmp_path: Path) -> None:
    audit = tmp_path / "docs" / "audit"
    importer = tmp_path / "db" / "importers"
    audit.mkdir(parents=True)
    importer.mkdir(parents=True)
    (audit / "source.md").write_text("firebase and ../wacrm are audited here", encoding="utf-8")
    (importer / "legacy.py").write_text("import sqlite3", encoding="utf-8")

    assert check_runtime_imports(tmp_path) == []
    assert check_sibling_independence(tmp_path) == []


def test_rejects_runtime_sibling_dependency(tmp_path: Path) -> None:
    service = tmp_path / "services" / "ts" / "worker"
    service.mkdir(parents=True)
    (service / "package.json").write_text(
        json.dumps({"dependencies": {"legacy": "file:../../../../wacrm"}}), encoding="utf-8"
    )

    assert "target runtime references sibling ../wacrm" in check_sibling_independence(tmp_path)[0]


def test_rejects_shared_package_dependency_on_service(tmp_path: Path) -> None:
    package = tmp_path / "packages" / "ts" / "shared"
    service = tmp_path / "services" / "ts" / "worker"
    package.mkdir(parents=True)
    service.mkdir(parents=True)
    (package / "package.json").write_text(
        json.dumps({"name": "@test/shared", "dependencies": {"@test/worker": "workspace:*"}}),
        encoding="utf-8",
    )
    (service / "package.json").write_text(json.dumps({"name": "@test/worker"}), encoding="utf-8")

    assert "shared package depends on @test/worker" in check_workspace_boundaries(tmp_path)[0]
