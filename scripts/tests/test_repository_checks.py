from __future__ import annotations

import json
from pathlib import Path

from scripts.check_repository import (
    check_node_manifests,
    check_python_workspace_boundaries,
    check_runtime_imports,
    check_sibling_independence,
    check_voice_topology,
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


def test_rejects_reversed_retained_python_dependency(tmp_path: Path) -> None:
    common = tmp_path / "packages" / "py" / "oron-common"
    sessions = tmp_path / "packages" / "py" / "oron-sessions"
    common.mkdir(parents=True)
    sessions.mkdir(parents=True)
    (common / "pyproject.toml").write_text(
        '[project]\nname = "oron-common"\nversion = "1.0.0"\ndependencies = ["oron-sessions"]\n',
        encoding="utf-8",
    )
    (sessions / "pyproject.toml").write_text(
        '[project]\nname = "oron-sessions"\nversion = "1.0.0"\n', encoding="utf-8"
    )

    errors = check_python_workspace_boundaries(tmp_path)
    assert any("forbids dependency on oron-sessions" in error for error in errors)


def test_rejects_public_redis_or_mutating_voice_probe(tmp_path: Path) -> None:
    compose = tmp_path / "infra" / "compose" / "compose.yaml"
    probe = tmp_path / "scripts" / "verify_voice_profile.py"
    compose.parent.mkdir(parents=True)
    probe.parent.mkdir(parents=True)
    compose.write_text(
        "\n".join(
            (
                "image: redis:8.10.1-alpine@sha256:test",
                "image: livekit/livekit-server:v1.13.6@sha256:test",
                "image: livekit/sip:v1.13.0@sha256:test",
                'ports: ["127.0.0.1:${LIVEKIT_PORT:-7880}:7880", "6379:6379"]',
            )
        ),
        encoding="utf-8",
    )
    probe.write_text("await client.sip.create_sip_participant(request)", encoding="utf-8")

    errors = check_voice_topology(tmp_path)

    assert any("voice port must remain private" in error for error in errors)
    assert any("mutating SIP method create_" in error for error in errors)
