"""Offline-verifiable Alembic graph, SQL, and database-contract checks."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

ROOT = Path(__file__).resolve().parents[1]
ALEMBIC_INI = ROOT / "db" / "alembic" / "alembic.ini"
MANIFEST_PATH = ROOT / "db" / "contracts" / "schema-manifest.json"
ARTIFACT_DIRECTORY = ROOT / ".artifacts" / "db"
OFFLINE_DATABASE_URL = "postgresql://offline:offline@127.0.0.1:1/offline"
ORON_REVISIONS = {
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
    "0e01a2f68295",
    "3b4a1c5307b4",
    "46a2cce29f18",
    "7433e45e0d29",
    "8aa960fd77ec",
    "8eda5976c920",
    "a41d2f6c2925",
    "b38ef3c19979",
    "c80d93f1c8be",
    "ea9aef9b2d14",
    "f596c72044b0",
}
PROHIBITED_SQL = {
    "Supabase Auth function": re.compile(r"\bauth\.uid\s*\(", re.IGNORECASE),
    "Supabase Auth table": re.compile(r"\bauth\.users\b", re.IGNORECASE),
    "Supabase Realtime publication": re.compile(r"\bsupabase_realtime\b", re.IGNORECASE),
    "Supabase Storage authority": re.compile(r"\bstorage\.objects\b", re.IGNORECASE),
    "runtime role SUPERUSER": re.compile(
        r"(?:CREATE|ALTER)\s+ROLE\s+platform_\w+[^;]*\sSUPERUSER\b", re.IGNORECASE
    ),
    "runtime role BYPASSRLS": re.compile(
        r"(?:CREATE|ALTER)\s+ROLE\s+platform_\w+[^;]*\sBYPASSRLS\b", re.IGNORECASE
    ),
    "grant to PUBLIC": re.compile(r"\bGRANT\b[^;]+\bTO\s+PUBLIC\b", re.IGNORECASE),
}


class VerificationError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class GraphReport:
    bases: tuple[str, ...]
    heads: tuple[str, ...]
    branch_points: tuple[str, ...]
    revision_count: int


def _manifest() -> dict[str, object]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def graph_report() -> GraphReport:
    scripts = ScriptDirectory.from_config(Config(ALEMBIC_INI))
    revisions = list(scripts.walk_revisions())
    revision_ids = [revision.revision for revision in revisions]
    if len(revision_ids) != len(set(revision_ids)):
        raise VerificationError("duplicate Alembic revision IDs detected")
    if not ORON_REVISIONS.issubset(revision_ids):
        missing = sorted(ORON_REVISIONS.difference(revision_ids))
        raise VerificationError(f"Or-on lineage revisions missing: {missing}")
    if scripts.get_bases() != ["0001"]:
        raise VerificationError(f"expected sole base 0001, found {scripts.get_bases()}")
    heads = scripts.get_heads()
    if len(heads) != 1:
        raise VerificationError(f"expected exactly one Alembic head, found {heads}")
    manifest_head = _manifest()["alembic_head"]
    if heads[0] != manifest_head:
        raise VerificationError(f"schema manifest head {manifest_head} differs from {heads[0]}")
    branch_points = tuple(
        sorted(revision.revision for revision in revisions if len(revision.nextrev) > 1)
    )
    return GraphReport(
        bases=tuple(scripts.get_bases()),
        heads=tuple(heads),
        branch_points=branch_points,
        revision_count=len(revisions),
    )


def _alembic(*arguments: str) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ)
    environment["DATABASE_URL"] = OFFLINE_DATABASE_URL
    return subprocess.run(  # noqa: S603
        [sys.executable, "-m", "alembic", "-c", str(ALEMBIC_INI), *arguments],
        cwd=ROOT,
        env=environment,
        check=True,
        text=True,
        capture_output=True,
    )


def render_offline_sql() -> str:
    return _alembic("upgrade", "head", "--sql").stdout


def _qualified_pattern(qualified_name: str) -> str:
    schema, table = qualified_name.split(".", maxsplit=1)
    return rf'"?{re.escape(schema)}"?\."?{re.escape(table)}"?'


def validate_contract(sql: str) -> None:
    manifest = _manifest()
    errors: list[str] = []
    if re.search(r"(?m)^\s*#", sql):
        errors.append("Python-style comment found in rendered PostgreSQL SQL")
    for label, pattern in PROHIBITED_SQL.items():
        if pattern.search(sql):
            errors.append(f"prohibited SQL detected: {label}")

    tenant_tables = manifest["tenant_rls_tables"]
    assert isinstance(tenant_tables, list)
    for qualified_name in tenant_tables:
        assert isinstance(qualified_name, str)
        qualified = _qualified_pattern(qualified_name)
        for clause in ("ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY"):
            if re.search(rf"ALTER TABLE\s+{qualified}\s+{clause}", sql, re.IGNORECASE) is None:
                errors.append(f"{qualified_name} is missing {clause}")
        if re.search(rf"CREATE POLICY\s+\S+\s+ON\s+{qualified}", sql, re.IGNORECASE) is None:
            errors.append(f"{qualified_name} is missing a tenant policy")

    extensions = manifest["extensions"]
    assert isinstance(extensions, dict)
    created_extensions = set(
        re.findall(r"CREATE EXTENSION IF NOT EXISTS\s+\"?([a-z0-9_]+)", sql, re.IGNORECASE)
    )
    required_extensions = set(extensions["required"])
    optional_extensions = set(extensions["optional"])
    if not required_extensions.issubset(created_extensions):
        errors.append(
            f"required extensions missing from migrations: "
            f"{sorted(required_extensions.difference(created_extensions))}"
        )
    accidentally_required = created_extensions.intersection(optional_extensions)
    if accidentally_required:
        errors.append(f"optional extensions became required: {sorted(accidentally_required)}")

    expected_indexes = manifest["expected_indexes"]
    assert isinstance(expected_indexes, list)
    for index_name in expected_indexes:
        assert isinstance(index_name, str)
        index_pattern = rf"CREATE (?:UNIQUE )?INDEX {re.escape(index_name)}\b"
        constraint_pattern = rf"CONSTRAINT {re.escape(index_name)} UNIQUE\b"
        if not re.search(index_pattern, sql) and not re.search(constraint_pattern, sql):
            errors.append(f"expected query index missing from SQL: {index_name}")

    security_definer_count = len(re.findall(r"\bSECURITY DEFINER\b", sql, re.IGNORECASE))
    secured_path_count = len(
        re.findall(r"\bSECURITY DEFINER\s+SET search_path\s*=", sql, re.IGNORECASE)
    )
    if security_definer_count != secured_path_count:
        errors.append("every SECURITY DEFINER function must set an explicit search_path")
    if "NOSUPERUSER" not in sql or "NOBYPASSRLS" not in sql:
        errors.append("successor runtime role declaration lacks explicit privilege denials")
    if errors:
        raise VerificationError("\n".join(errors))


def verify_offline(*, write_sql: bool) -> dict[str, object]:
    graph = graph_report()
    for command in (("history",), ("heads",), ("branches",)):
        _alembic(*command)
    first = render_offline_sql()
    second = render_offline_sql()
    if first != second:
        raise VerificationError("offline Alembic SQL is not deterministic")
    validate_contract(first)
    digest = hashlib.sha256(first.encode()).hexdigest()
    if write_sql:
        ARTIFACT_DIRECTORY.mkdir(parents=True, exist_ok=True)
        (ARTIFACT_DIRECTORY / "migration-head.sql").write_text(first, encoding="utf-8")
    return {
        "bases": list(graph.bases),
        "heads": list(graph.heads),
        "branch_points": list(graph.branch_points),
        "revision_count": graph.revision_count,
        "oron_revision_count": len(ORON_REVISIONS),
        "offline_sql_bytes": len(first.encode()),
        "offline_sql_sha256": digest,
        "contract": "passed",
    }


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "offline"
    if command == "graph":
        report = graph_report()
        result: dict[str, object] = {
            "bases": list(report.bases),
            "heads": list(report.heads),
            "branch_points": list(report.branch_points),
            "revision_count": report.revision_count,
        }
    elif command == "sql":
        result = verify_offline(write_sql=True)
    elif command == "contract":
        sql = render_offline_sql()
        validate_contract(sql)
        result = {"contract": "passed", "alembic_head": graph_report().heads[0]}
    elif command == "offline":
        result = verify_offline(write_sql=True)
    else:
        raise VerificationError(f"unknown database verification command: {command}")
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.CalledProcessError, VerificationError) as error:
        print(f"DATABASE VERIFICATION FAILED: {error}", file=sys.stderr)
        raise SystemExit(1) from error
