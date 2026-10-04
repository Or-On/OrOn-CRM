"""Restore guard tests use synthetic archives and never connect to PostgreSQL."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import io
import json
import tarfile
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "restore_dev_backup", ROOT / "scripts/restore-dev-backup.py"
)
assert spec and spec.loader
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


def archive(tmp_path, mutation=None, full=True):
    release = "a" * 40
    head = "b" * 12
    nested = io.BytesIO()
    with tarfile.open(fileobj=nested, mode="w") as tar:
        item = tarfile.TarInfo("../escape" if mutation == "nested_traversal" else "synthetic.txt")
        item.size = 4
        tar.addfile(item, io.BytesIO(b"test"))
    members = {
        "database.dump": b"dump",
        "release.txt": release.encode(),
        "schema-head.txt": head.encode(),
        "security-contract.json": b"{}",
        "release.tar": nested.getvalue(),
        "backup-manifest.json": json.dumps(
            {
                "formatVersion": 2,
                "database": "source_fixture",
                "release": release,
                "schemaHead": head,
                "databaseOnly": not full,
                "objectsIncluded": full,
                "releaseIncluded": True,
                "keyMaterialIncluded": False,
            }
        ).encode(),
    }
    if full:
        members["objects.tar"] = nested.getvalue()
    if mutation == "schema":
        members["schema-head.txt"] = b"c" * 12
    checksums = "".join(
        f"{hashlib.sha256(value).hexdigest()}  {name}\n" for name, value in members.items()
    )
    if mutation == "checksum":
        checksums = checksums.replace(hashlib.sha256(b"dump").hexdigest(), "0" * 64)
    if mutation == "checksum_path":
        checksums += "0" * 64 + "  ../escape\n"
    members["SHA256SUMS"] = checksums.encode()
    target = tmp_path / "backup.tar.gz"
    with tarfile.open(target, "w:gz") as tar:
        for name, value in members.items():
            item = tarfile.TarInfo(name)
            item.size = len(value)
            tar.addfile(item, io.BytesIO(value))
        if mutation in ("link", "traversal", "duplicate"):
            name = (
                "../escape"
                if mutation == "traversal"
                else "database.dump"
                if mutation == "duplicate"
                else "link"
            )
            item = tarfile.TarInfo(name)
            if mutation == "link":
                item.type = tarfile.SYMTYPE
                item.linkname = "/etc/passwd"
            tar.addfile(item)
    return target, hashlib.sha256(target.read_bytes()).hexdigest()


@pytest.mark.parametrize("full", [True, False])
def test_full_and_database_only_formats_validate_without_keys(tmp_path, full):
    file, digest = archive(tmp_path, full=full)
    stage = tmp_path / "stage"
    stage.mkdir()
    manifest = restore.validate_archive(file, digest, stage)
    assert manifest["objectsIncluded"] == full
    assert manifest["keyMaterialIncluded"] is False


@pytest.mark.parametrize(
    "mutation",
    ["nested_traversal", "schema", "checksum", "checksum_path", "link", "traversal", "duplicate"],
)
def test_corrupt_or_unsafe_backup_fails_before_database_access(tmp_path, mutation):
    file, digest = archive(tmp_path, mutation)
    stage = tmp_path / "stage"
    stage.mkdir()
    with pytest.raises(restore.RestoreRefused):
        restore.validate_archive(file, digest, stage)
    assert not (tmp_path / "escape").exists()


def test_outer_checksum_and_expanded_size_are_enforced(tmp_path):
    file, digest = archive(tmp_path)
    stage = tmp_path / "stage"
    stage.mkdir()
    with pytest.raises(restore.RestoreRefused, match="Outer"):
        restore.validate_archive(file, "0" * 64, stage)
    with pytest.raises(restore.RestoreRefused, match="size"):
        restore.validate_archive(file, digest, stage, 10)


@pytest.mark.parametrize(
    "dsn,target,confirmation",
    [
        ("postgresql://fixture@remote.invalid:55480/source", "valid", "valid"),
        ("postgresql://fixture@127.0.0.1:5432/source", "valid", "valid"),
        ("postgresql://fixture@127.0.0.1:55480/source?options=unsafe", "valid", "valid"),
        ("postgresql://fixture@127.0.0.1:55480/source", "shared_database", "shared_database"),
        ("postgresql://fixture@127.0.0.1:55480/source", "valid", "other"),
    ],
)
def test_mismatched_restore_target_is_denied(dsn, target, confirmation):
    fresh = "oron_restore_" + uuid4().hex
    target = fresh if target == "valid" else target
    confirmation = fresh if confirmation == "valid" else confirmation
    with pytest.raises(restore.RestoreRefused):
        restore.validate_target(dsn, target, confirmation, "source")


def test_exact_fresh_owned_target_is_the_only_allowed_route():
    target = "oron_restore_" + uuid4().hex
    assert restore.validate_target(
        "postgresql://fixture@127.0.0.1:55480/source", target, target, "source"
    ).endswith("/" + target)
    with pytest.raises(restore.RestoreRefused):
        restore.validate_target(
            "postgresql://fixture@127.0.0.1:55480/source", target, target, target
        )


def test_backup_refuses_overwrite_and_serializes_full_backup_with_deployment():
    source = (ROOT / "scripts/backup-dev.sh").read_text()
    assert "refusing to overwrite recovery evidence" in source
    assert "flock --shared --nonblock 8" in source
    assert "security-contract.json release.tar backup-manifest.json" in source
    assert "keyMaterialIncluded" in source and "external_required" in source


@pytest.mark.parametrize(
    "contract",
    [
        None,
        {},
        {"requiredRoles": [None]},
        {
            "requiredRoles": [
                {"name": "platform_web", "superuser": 0, "bypassRls": False, "login": True}
            ],
            "protectedTables": [
                {"schema": "crm", "name": "contacts", "rls": True, "forceRls": True}
            ],
            "functionOwners": [{"identity": "crm.fixture()", "owner": "platform_migrator"}],
        },
    ],
)
def test_malformed_security_contract_is_denied_before_database_creation(contract):
    with pytest.raises(restore.RestoreRefused):
        restore.validate_security_contract(contract)


def evaluator_contract() -> dict[str, Any]:
    return {
        "requiredRoles": [{"name": restore.EVALUATOR, **dict.fromkeys(restore.ROLE_FLAGS, False)}],
        "roleMemberships": [],
        "evaluatorCapabilities": sorted(restore.EVALUATOR_FUNCTIONS),
        "protectedTables": [{"schema": "crm", "name": "contacts", "rls": True, "forceRls": True}],
        "functionOwners": [{"identity": "crm.fixture()", "owner": "platform_migrator"}],
    }


def test_inert_evaluator_exact_capability_contract_allowed():
    restore.validate_security_contract(evaluator_contract())


@pytest.mark.parametrize("flag", list(restore.ROLE_FLAGS))
def test_evaluator_unsafe_or_missing_role_flags_denied(flag):
    for value in (True, None):
        contract = evaluator_contract()
        contract["requiredRoles"][0][flag] = value
        with pytest.raises(restore.RestoreRefused):
            restore.validate_security_contract(contract)


@pytest.mark.parametrize("direction", ["role", "member"])
def test_evaluator_role_membership_both_directions_denied(direction):
    contract = evaluator_contract()
    contract["roleMemberships"] = [
        {
            "role": "platform_web",
            "member": "platform_web",
            "admin": False,
            "inherit": False,
            "set": True,
            direction: restore.EVALUATOR,
        }
    ]
    with pytest.raises(restore.RestoreRefused, match="membership"):
        restore.validate_security_contract(contract)


@pytest.mark.parametrize("mutation", ["missing", "additional", "duplicate"])
def test_evaluator_capability_drift_denied(mutation):
    contract = evaluator_contract()
    if mutation == "missing":
        contract["evaluatorCapabilities"].pop()
    elif mutation == "additional":
        contract["evaluatorCapabilities"].append("platform.other()")
    else:
        contract["evaluatorCapabilities"].append(contract["evaluatorCapabilities"][0])
    with pytest.raises(restore.RestoreRefused, match="capability"):
        restore.validate_security_contract(contract)


@pytest.mark.parametrize("mutation", [None, "grant_option", "table_grant", "missing"])
def test_restored_actual_capability_projection_is_checked(mutation):
    class Projection:
        async def fetch(self, _query, _role):
            rows = [
                {"identity": value, "is_grantable": mutation == "grant_option"}
                for value in restore.EVALUATOR_FUNCTIONS
            ]
            return rows[:-1] if mutation == "missing" else rows

        async def fetchval(self, _query, _role, _functions):
            return mutation == "table_grant"

    if mutation is None:
        asyncio.run(restore.verify_evaluator_capabilities(Projection()))
    else:
        with pytest.raises(restore.RestoreRefused):
            asyncio.run(restore.verify_evaluator_capabilities(Projection()))


def memory_controller_contract():
    contract = evaluator_contract()
    contract["requiredRoles"] = [
        {
            "name": restore.MEMORY_CONTROLLER,
            **dict.fromkeys(restore.ROLE_FLAGS, False),
        }
    ]
    contract.pop("evaluatorCapabilities")
    contract["memoryControllerCapabilities"] = sorted(restore.MEMORY_CONTROLLER_FUNCTIONS)
    return contract


def test_memory_controller_exact_inert_contract_allowed():
    restore.validate_security_contract(memory_controller_contract())


@pytest.mark.parametrize("flag", list(restore.ROLE_FLAGS))
def test_memory_controller_unsafe_or_missing_flags_denied(flag):
    for mutation in (True, None):
        contract = memory_controller_contract()
        contract["requiredRoles"][0][flag] = mutation
        with pytest.raises(restore.RestoreRefused):
            restore.validate_security_contract(contract)


@pytest.mark.parametrize("direction", ["role", "member"])
def test_memory_controller_membership_denied_in_both_directions(direction):
    contract = memory_controller_contract()
    contract["roleMemberships"] = [
        {
            "role": "platform_web",
            "member": "platform_messaging",
            "admin": False,
            "inherit": False,
            "set": True,
            direction: restore.MEMORY_CONTROLLER,
        }
    ]
    with pytest.raises(restore.RestoreRefused):
        restore.validate_security_contract(contract)


@pytest.mark.parametrize("mutation", ["missing", "excess", "duplicate", "absent"])
def test_memory_controller_capability_drift_denied(mutation):
    contract = memory_controller_contract()
    if mutation == "missing":
        contract["memoryControllerCapabilities"].pop()
    elif mutation == "excess":
        contract["memoryControllerCapabilities"].append(
            "agents.write_customer_memory_summary(uuid)"
        )
    elif mutation == "duplicate":
        contract["memoryControllerCapabilities"].append(contract["memoryControllerCapabilities"][0])
    else:
        contract.pop("memoryControllerCapabilities")
    with pytest.raises(restore.RestoreRefused):
        restore.validate_security_contract(contract)


@pytest.mark.parametrize("grantable,excess", [(False, False), (True, False), (False, True)])
def test_restored_memory_controller_actual_acl_projection_guard(grantable, excess):
    class Projection:
        async def fetch(self, *args):
            return [
                {"identity": value, "is_grantable": grantable}
                for value in restore.MEMORY_CONTROLLER_FUNCTIONS
            ]

        async def fetchval(self, query, *args):
            assert "agents.attest_real_memory_source(uuid,text)" in query
            assert "NOT IN ('agents','platform')" in query
            return excess

    if grantable or excess:
        with pytest.raises(restore.RestoreRefused):
            asyncio.run(restore.verify_memory_controller_capabilities(Projection()))
    else:
        asyncio.run(restore.verify_memory_controller_capabilities(Projection()))


def whatsapp_verifier_contract():
    contract = memory_controller_contract()
    contract["requiredRoles"][0]["name"] = restore.WHATSAPP_VERIFIER
    contract.pop("memoryControllerCapabilities")
    contract["whatsappVerifierCapabilities"] = sorted(restore.WHATSAPP_VERIFIER_FUNCTIONS)
    return contract


def test_whatsapp_verifier_exact_inert_contract_allowed():
    restore.validate_security_contract(whatsapp_verifier_contract())


@pytest.mark.parametrize("flag", list(restore.ROLE_FLAGS))
def test_whatsapp_verifier_unsafe_or_missing_flags_denied(flag):
    for mutation in (True, None):
        contract = whatsapp_verifier_contract()
        contract["requiredRoles"][0][flag] = mutation
        with pytest.raises(restore.RestoreRefused):
            restore.validate_security_contract(contract)


@pytest.mark.parametrize("direction", ["role", "member"])
def test_whatsapp_verifier_membership_denied_both_directions(direction):
    contract = whatsapp_verifier_contract()
    contract["roleMemberships"] = [
        {
            "role": "platform_web",
            "member": "platform_messaging",
            "admin": False,
            "inherit": False,
            "set": True,
            direction: restore.WHATSAPP_VERIFIER,
        }
    ]
    with pytest.raises(restore.RestoreRefused):
        restore.validate_security_contract(contract)


@pytest.mark.parametrize("mutation", ["missing", "excess", "duplicate", "absent"])
def test_whatsapp_verifier_capability_drift_denied(mutation):
    contract = whatsapp_verifier_contract()
    if mutation == "missing":
        contract["whatsappVerifierCapabilities"].pop()
    elif mutation == "excess":
        contract["whatsappVerifierCapabilities"].append(
            "agents.attest_real_memory_source(uuid,text)"
        )
    elif mutation == "duplicate":
        contract["whatsappVerifierCapabilities"].append(contract["whatsappVerifierCapabilities"][0])
    else:
        contract.pop("whatsappVerifierCapabilities")
    with pytest.raises(restore.RestoreRefused):
        restore.validate_security_contract(contract)
