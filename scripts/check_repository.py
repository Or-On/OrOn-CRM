"""Enforce target-runtime database, migration, and sibling-independence rules."""

from __future__ import annotations

import json
import os
import re
import tomllib
from collections.abc import Iterable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ROOTS = ("apps", "services", "packages", "db", "infra")
SKIPPED_PARTS = {
    ".artifacts",
    ".git",
    ".next",
    ".terraform",
    ".venv",
    "__pycache__",
    "dist",
    "node_modules",
}
PROHIBITED_NODE_PACKAGES = {
    "@libsql/client",
    "@pinecone-database/pinecone",
    "@supabase/ssr",
    "@supabase/supabase-js",
    "better-sqlite3",
    "firebase",
    "firebase-admin",
    "mongodb",
    "mongoose",
    "qdrant-client",
    "sqlite3",
    "typeorm",
    "weaviate-client",
}
PROHIBITED_PYTHON_PACKAGES = {
    "aiosqlite",
    "firebase-admin",
    "motor",
    "pinecone",
    "pinecone-client",
    "pymongo",
    "pysqlite3",
    "qdrant-client",
    "supabase",
    "weaviate-client",
}
PROHIBITED_DATABASE_IMAGES = ("cockroach", "mariadb", "mongo", "mysql", "qdrant", "weaviate")
JS_IMPORT = re.compile(
    r"(?:from\s+|import\s+|import\s*\(|require\s*\()\s*['\"](?P<package>[^'\"]+)['\"]"
)
PY_IMPORT = re.compile(r"^\s*(?:from|import)\s+(?P<package>[A-Za-z0-9_\.]+)", re.MULTILINE)
ORON_ALLOWED_DEPENDENCIES = {
    "oron-agent": {
        "oron-common",
        "oron-flows",
        "oron-hebrew",
        "oron-secrets",
        "oron-sessions",
    },
    "oron-common": set(),
    "oron-db": set(),
    "oron-dispatcher": {"oron-common", "oron-sessions"},
    "oron-flows": {"oron-common"},
    "oron-hebrew": {"oron-common"},
    "oron-secrets": set(),
    "oron-tenancy": {"oron-common", "oron-db", "oron-flows"},
    "oron-sessions": {
        "oron-common",
        "oron-db",
        "oron-flows",
        "oron-secrets",
        "oron-tenancy",
    },
}


def _walk_files(root: Path, start: Path) -> Iterable[Path]:
    if not start.exists():
        return
    for directory, directories, files in os.walk(start):
        directories[:] = [name for name in directories if name not in SKIPPED_PARTS]
        current = Path(directory)
        if "importers" in current.relative_to(root).parts:
            directories[:] = []
            continue
        for filename in files:
            yield current / filename


def _package_root(specifier: str) -> str:
    if specifier.startswith("@"):
        return "/".join(specifier.split("/")[:2])
    return specifier.split("/")[0]


def check_node_manifests(root: Path) -> list[str]:
    errors: list[str] = []
    for manifest in _walk_files(root, root):
        if manifest.name != "package.json":
            continue
        document = json.loads(manifest.read_text(encoding="utf-8"))
        for section in ("dependencies", "optionalDependencies", "peerDependencies"):
            for package in document.get(section, {}):
                if package in PROHIBITED_NODE_PACKAGES:
                    errors.append(
                        f"{manifest.relative_to(root)}: prohibited runtime dependency {package}"
                    )
    return errors


def check_python_manifests(root: Path) -> list[str]:
    errors: list[str] = []
    for manifest in _walk_files(root, root):
        if manifest.name != "pyproject.toml":
            continue
        document = tomllib.loads(manifest.read_text(encoding="utf-8"))
        dependencies = document.get("project", {}).get("dependencies", [])
        for dependency in dependencies:
            normalized = re.split(r"[<>=!~\[ ;]", dependency.lower(), maxsplit=1)[0]
            if normalized in PROHIBITED_PYTHON_PACKAGES:
                errors.append(
                    f"{manifest.relative_to(root)}: prohibited runtime dependency {normalized}"
                )
    return errors


def check_runtime_imports(root: Path) -> list[str]:
    errors: list[str] = []
    for relative_root in RUNTIME_ROOTS:
        for source in _walk_files(root, root / relative_root):
            if source.suffix not in {".js", ".jsx", ".mjs", ".py", ".ts", ".tsx"}:
                continue
            content = source.read_text(encoding="utf-8")
            if source.suffix == ".py":
                imports = (
                    match.group("package").split(".")[0].replace("_", "-")
                    for match in PY_IMPORT.finditer(content)
                )
                prohibited = PROHIBITED_PYTHON_PACKAGES | {"sqlite3"}
            else:
                imports = (
                    _package_root(match.group("package")) for match in JS_IMPORT.finditer(content)
                )
                prohibited = PROHIBITED_NODE_PACKAGES | {"bun:sqlite"}
            for package in imports:
                if package in prohibited:
                    errors.append(
                        f"{source.relative_to(root)}: prohibited runtime import {package}"
                    )
    return errors


def check_sibling_independence(root: Path) -> list[str]:
    errors: list[str] = []
    sibling_fragments = ("../" + name for name in ("or-on", "wacrm", "openlive"))
    fragments = tuple(sibling_fragments)
    checked_suffixes = {
        ".js",
        ".json",
        ".mjs",
        ".py",
        ".sql",
        ".toml",
        ".ts",
        ".tsx",
        ".yaml",
        ".yml",
    }
    for relative_root in RUNTIME_ROOTS:
        for source in _walk_files(root, root / relative_root):
            if source.suffix not in checked_suffixes and source.name not in {
                "Dockerfile",
                "Makefile",
            }:
                continue
            content = source.read_text(encoding="utf-8").replace("\\", "/").lower()
            for fragment in fragments:
                if fragment in content:
                    errors.append(
                        f"{source.relative_to(root)}: target runtime references sibling {fragment}"
                    )
    return errors


def check_external_symlinks(root: Path) -> list[str]:
    errors: list[str] = []
    resolved_root = root.resolve()
    for relative_root in RUNTIME_ROOTS:
        for item in _walk_files(root, root / relative_root):
            if item.is_symlink() and not item.resolve().is_relative_to(resolved_root):
                errors.append(f"{item.relative_to(root)}: symlink leaves target repository")
    return errors


def check_database_topology(root: Path) -> list[str]:
    compose = root / "infra" / "compose" / "compose.yaml"
    content = compose.read_text(encoding="utf-8").lower()
    errors = [
        f"{compose.relative_to(root)}: prohibited database image reference {name}"
        for name in PROHIBITED_DATABASE_IMAGES
        if re.search(rf"^\s*image:\s*[^\n]*{re.escape(name)}", content, re.MULTILINE)
    ]
    if "postgres:18.6-bookworm" not in content:
        errors.append(f"{compose.relative_to(root)}: selected PostgreSQL 18.6 image is missing")
    competing_directories = {"prisma", "drizzle", "supabase"}
    for relative_root in ("apps", "services", "packages", "db"):
        start = root / relative_root
        if not start.exists():
            continue
        for directory, directories, _ in os.walk(start):
            directories[:] = [name for name in directories if name not in SKIPPED_PARTS]
            for name in directories:
                if name.lower() in competing_directories:
                    path = Path(directory, name).relative_to(root)
                    errors.append(f"{path}: competing migration authority directory")
    return errors


def check_voice_topology(root: Path) -> list[str]:
    """Keep the optional control plane pinned, private, and mutation-free."""
    compose = root / "infra" / "compose" / "compose.yaml"
    content = compose.read_text(encoding="utf-8")
    errors: list[str] = []
    required_images = (
        "redis:8.10.1-alpine@sha256:",
        "livekit/livekit-server:v1.13.6@sha256:",
        "livekit/sip:v1.13.0@sha256:",
    )
    for image in required_images:
        if image not in content:
            errors.append(f"{compose.relative_to(root)}: pinned voice image missing {image}")
    for binding in ('"6379:6379"', '"5060:5060', '"10000-10100:'):
        if binding in content:
            errors.append(f"{compose.relative_to(root)}: voice port must remain private {binding}")
    if '"127.0.0.1:${LIVEKIT_PORT:-7880}:7880"' not in content:
        errors.append(f"{compose.relative_to(root)}: LiveKit control port is not loopback-bound")

    probe = root / "scripts" / "verify_voice_profile.py"
    probe_content = probe.read_text(encoding="utf-8")
    for mutation in ("create_", "update_", "delete_", "transfer_", "participant"):
        if f"client.sip.{mutation}" in probe_content:
            errors.append(f"{probe.relative_to(root)}: mutating SIP method {mutation}")
    return errors


def check_workspace_boundaries(root: Path) -> list[str]:
    manifests: dict[str, tuple[Path, dict[str, object]]] = {}
    for manifest in _walk_files(root, root):
        if manifest.name != "package.json":
            continue
        document = json.loads(manifest.read_text(encoding="utf-8"))
        name = document.get("name")
        if isinstance(name, str):
            manifests[name] = (manifest, document)

    graph: dict[str, set[str]] = {name: set() for name in manifests}
    errors: list[str] = []
    for source_name, (source_path, document) in manifests.items():
        source_area = source_path.relative_to(root).parts[0]
        dependencies: set[str] = set()
        for section in ("dependencies", "optionalDependencies", "peerDependencies"):
            values = document.get(section)
            if isinstance(values, dict):
                dependencies.update(
                    dependency
                    for dependency in values
                    if isinstance(dependency, str) and dependency in manifests
                )
        graph[source_name].update(dependencies)
        for dependency in dependencies:
            target_path = manifests[dependency][0]
            target_area = target_path.relative_to(root).parts[0]
            if source_area == "packages" and target_area in {"apps", "services"}:
                errors.append(
                    f"{source_path.relative_to(root)}: shared package depends on {dependency}"
                )
            if {source_area, target_area} == {"apps", "services"}:
                errors.append(
                    f"{source_path.relative_to(root)}: app/service source dependency "
                    f"on {dependency}"
                )

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(name: str, trail: list[str]) -> None:
        if name in visiting:
            cycle = " -> ".join([*trail[trail.index(name) :], name])
            errors.append(f"workspace dependency cycle: {cycle}")
            return
        if name in visited:
            return
        visiting.add(name)
        trail.append(name)
        for dependency in sorted(graph[name]):
            visit(dependency, trail)
        trail.pop()
        visiting.remove(name)
        visited.add(name)

    for package in sorted(graph):
        visit(package, [])
    return errors


def _python_dependency_name(requirement: str) -> str:
    return re.split(r"[<>=!~\[ ;]", requirement.lower(), maxsplit=1)[0]


def check_python_workspace_boundaries(root: Path) -> list[str]:
    """Keep retained Or-on packages one-way and all Python workspaces acyclic."""

    manifests: dict[str, tuple[Path, dict[str, object]]] = {}
    for area in (root / "packages" / "py", root / "services" / "py"):
        for manifest in _walk_files(root, area):
            if manifest.name != "pyproject.toml":
                continue
            document = tomllib.loads(manifest.read_text(encoding="utf-8"))
            project = document.get("project")
            if not isinstance(project, dict):
                continue
            name = project.get("name")
            if isinstance(name, str):
                manifests[name] = (manifest, document)

    graph: dict[str, set[str]] = {name: set() for name in manifests}
    errors: list[str] = []
    for source_name, (source_path, document) in manifests.items():
        project = document.get("project")
        assert isinstance(project, dict)
        requirements = project.get("dependencies", [])
        dependencies = {
            name
            for requirement in requirements
            if isinstance(requirement, str)
            and (name := _python_dependency_name(requirement)) in manifests
        }
        graph[source_name].update(dependencies)
        if source_name in ORON_ALLOWED_DEPENDENCIES:
            forbidden = {
                dependency
                for dependency in dependencies
                if dependency.startswith("oron-")
                and dependency not in ORON_ALLOWED_DEPENDENCIES[source_name]
            }
            for dependency in sorted(forbidden):
                errors.append(
                    f"{source_path.relative_to(root)}: retained package direction "
                    f"forbids dependency on {dependency}"
                )
        if source_path.is_relative_to(root / "packages"):
            for dependency in sorted(dependencies):
                target_path = manifests[dependency][0]
                if target_path.is_relative_to(root / "services"):
                    errors.append(
                        f"{source_path.relative_to(root)}: shared Python package depends on "
                        f"service {dependency}"
                    )

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(name: str, trail: list[str]) -> None:
        if name in visiting:
            cycle = " -> ".join([*trail[trail.index(name) :], name])
            errors.append(f"Python workspace dependency cycle: {cycle}")
            return
        if name in visited:
            return
        visiting.add(name)
        trail.append(name)
        for dependency in sorted(graph[name]):
            visit(dependency, trail)
        trail.pop()
        visiting.remove(name)
        visited.add(name)

    for package in sorted(graph):
        visit(package, [])
    return errors


def collect_errors(root: Path = ROOT) -> list[str]:
    return [
        *check_node_manifests(root),
        *check_python_manifests(root),
        *check_runtime_imports(root),
        *check_sibling_independence(root),
        *check_external_symlinks(root),
        *check_database_topology(root),
        *check_voice_topology(root),
        *check_workspace_boundaries(root),
        *check_python_workspace_boundaries(root),
    ]


def main() -> None:
    errors = collect_errors()
    if errors:
        print("Repository policy violations:")
        for error in errors:
            print(f"- {error}")
        raise SystemExit(1)
    print(
        "Repository policy checks passed: PostgreSQL-only, Alembic-only, "
        "sibling-independent, workspace boundaries intact"
    )


if __name__ == "__main__":
    main()
