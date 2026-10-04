#!/usr/bin/env python3
"""Validate and drill a DEV backup on an explicitly owned fresh local database.

This prepared drill tool deliberately cannot restore a shared or remote database,
change roles/passwords, configure cloud storage, or supply escrowed key material.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit, urlunsplit

REQUIRED = {
    "database.dump",
    "release.txt",
    "schema-head.txt",
    "security-contract.json",
    "release.tar",
    "backup-manifest.json",
    "SHA256SUMS",
}
TARGET = re.compile(r"oron_restore_[a-f0-9]{32}")
EVALUATOR = "platform_agent_evaluation"
EVALUATOR_FUNCTIONS = {
    "platform.claim_agent_quality_evaluation()",
    "platform.append_agent_quality_case(uuid,uuid,uuid,jsonb)",
    "platform.finalize_agent_quality_evaluation(uuid,uuid)",
    "platform.fail_agent_quality_evaluation(uuid,uuid,text)",
    "platform.queue_nightly_agent_quality_evaluations(integer)",
}
MEMORY_CONTROLLER = "platform_memory_review_controller"
MEMORY_CONTROLLER_FUNCTIONS = {
    "platform.current_tenant_id()",
    "agents.attest_real_memory_source(uuid,text)",
}
WHATSAPP_VERIFIER = "platform_whatsapp_verifier"
WHATSAPP_VERIFIER_FUNCTIONS = {"agents.attest_whatsapp_signature(uuid,text,jsonb)"}
ROLE_FLAGS = {
    "superuser": "rolsuper",
    "bypassRls": "rolbypassrls",
    "login": "rolcanlogin",
    "inherit": "rolinherit",
    "createDb": "rolcreatedb",
    "createRole": "rolcreaterole",
    "replication": "rolreplication",
}


class RestoreRefused(ValueError):
    pass


def safe_members(bundle: tarfile.TarFile, maximum: int) -> list[tarfile.TarInfo]:
    result = bundle.getmembers()
    if len(result) > 100_000:
        raise RestoreRefused("Archive has too many members")
    seen: set[str] = set()
    total = 0
    for member in result:
        path = PurePosixPath(member.name)
        normalized = str(path)
        if (
            len(member.name) > 4096
            or any(ord(character) < 32 for character in member.name)
            or path.is_absolute()
            or ".." in path.parts
            or "\\" in member.name
            or re.match(r"^[A-Za-z]:", member.name)
            or normalized in seen
            or not (member.isdir() or member.isfile())
            or member.size < 0
        ):
            raise RestoreRefused("Archive path, duplicate, link or special file denied")
        seen.add(normalized)
        total += member.size
    if total > maximum:
        raise RestoreRefused("Archive exceeds configured expanded-size limit")
    return result


def validate_archive(
    archive: Path, expected_sha: str, destination: Path, maximum: int = 1024**3
) -> dict:
    if not re.fullmatch("[a-f0-9]{64}", expected_sha):
        raise RestoreRefused("Explicit SHA-256 is required")
    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024**2), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected_sha:
        raise RestoreRefused("Outer backup checksum mismatch")
    with tarfile.open(archive, "r:gz") as bundle:
        members = safe_members(bundle, maximum)
        names = {member.name for member in members if member.isfile()}
        if names not in (REQUIRED, REQUIRED | {"objects.tar"}) or any(m.isdir() for m in members):
            raise RestoreRefused("Backup members do not match format 2")
        bundle.extractall(destination, members=members, filter="data")
    manifest = json.loads((destination / "backup-manifest.json").read_text())
    if manifest.get("formatVersion") != 2 or manifest.get("keyMaterialIncluded") is not False:
        raise RestoreRefused("Unsupported or unsafe backup manifest")
    if (
        manifest.get("databaseOnly") is not ("objects.tar" not in names)
        or manifest.get("objectsIncluded") is not ("objects.tar" in names)
        or manifest.get("releaseIncluded") is not True
    ):
        raise RestoreRefused("Manifest does not match backup mode")
    head = (destination / "schema-head.txt").read_text().strip()
    release = (destination / "release.txt").read_text().strip()
    if (
        not re.fullmatch("[a-f0-9]{12}", head)
        or head != manifest.get("schemaHead")
        or not re.fullmatch("[a-f0-9]{40}", release)
        or release != manifest.get("release")
    ):
        raise RestoreRefused("Backup schema/release identity mismatch")
    lines = (destination / "SHA256SUMS").read_text().splitlines()
    checked: set[str] = set()
    for line in lines:
        match = re.fullmatch(r"([a-f0-9]{64}) [ *]([A-Za-z0-9_.-]+)", line)
        if not match or match[2] not in names - {"SHA256SUMS"} or match[2] in checked:
            raise RestoreRefused("Unsafe or duplicate checksum manifest entry")
        checked.add(match[2])
        with (destination / match[2]).open("rb") as member_stream:
            actual_digest = hashlib.file_digest(member_stream, "sha256").hexdigest()
        if actual_digest != match[1]:
            raise RestoreRefused("Backup member checksum mismatch")
    if checked != names - {"SHA256SUMS"}:
        raise RestoreRefused("Every backup member requires an internal checksum")
    for filename in ("release.tar", "objects.tar"):
        if filename in names:
            with tarfile.open(destination / filename) as nested:
                safe_members(nested, maximum)
    return manifest


def validate_target(dsn: str, target: str, confirmation: str, source_database: str) -> str:
    parsed = urlsplit(dsn)
    if (
        parsed.scheme != "postgresql"
        or parsed.hostname != "127.0.0.1"
        or parsed.port != 55480
        or parsed.query
        or parsed.fragment
    ):
        raise RestoreRefused("Restore requires the explicitly owned loopback fixture endpoint")
    if not TARGET.fullmatch(target) or target != confirmation or target == source_database:
        raise RestoreRefused("Fresh target name and exact confirmation are required")
    return urlunsplit(parsed._replace(path="/" + target))


def validate_security_contract(contract: dict) -> None:
    requirements = {
        "requiredRoles": {"name": str, "superuser": bool, "bypassRls": bool, "login": bool},
        "protectedTables": {"schema": str, "name": str, "rls": bool, "forceRls": bool},
        "functionOwners": {"identity": str, "owner": str},
    }
    if not isinstance(contract, dict):
        raise RestoreRefused("Complete security contract required")
    for group, fields in requirements.items():
        rows = contract.get(group)
        if not isinstance(rows, list) or not rows:
            raise RestoreRefused("Complete security contract required")
        for row in rows:
            if not isinstance(row, dict) or any(
                type(row.get(field)) is not kind for field, kind in fields.items()
            ):
                raise RestoreRefused("Malformed security contract")
            if any(not row[field] for field, kind in fields.items() if kind is str):
                raise RestoreRefused("Empty security identity")
    evaluators = [r for r in contract["requiredRoles"] if r["name"] == EVALUATOR]
    if evaluators:
        if len(evaluators) != 1 or any(evaluators[0].get(flag) is not False for flag in ROLE_FLAGS):
            raise RestoreRefused("Evaluator requires an inert least-privilege role")
        memberships = contract.get("roleMemberships")
        if not isinstance(memberships, list) or any(
            not isinstance(row, dict)
            or any(type(row.get(k)) is not str for k in ("role", "member"))
            or any(type(row.get(k)) is not bool for k in ("admin", "inherit", "set"))
            for row in memberships
        ):
            raise RestoreRefused("Complete role membership contract required")
        if any(EVALUATOR in (row["role"], row["member"]) for row in memberships):
            raise RestoreRefused("Evaluator membership requires explicit separate approval")
        capabilities = contract.get("evaluatorCapabilities")
        if (
            not isinstance(capabilities, list)
            or any(type(value) is not str for value in capabilities)
            or len(capabilities) != len(EVALUATOR_FUNCTIONS)
            or set(capabilities) != EVALUATOR_FUNCTIONS
        ):
            raise RestoreRefused("Evaluator capability contract mismatch")

    controllers = [r for r in contract["requiredRoles"] if r["name"] == MEMORY_CONTROLLER]
    if controllers:
        if len(controllers) != 1 or any(
            controllers[0].get(flag) is not False for flag in ROLE_FLAGS
        ):
            raise RestoreRefused("Memory controller requires an inert least-privilege role")
        memberships = contract.get("roleMemberships")
        if not isinstance(memberships, list) or any(
            not isinstance(row, dict)
            or any(type(row.get(k)) is not str for k in ("role", "member"))
            or any(type(row.get(k)) is not bool for k in ("admin", "inherit", "set"))
            for row in memberships
        ):
            raise RestoreRefused("Complete role membership contract required")
        if any(MEMORY_CONTROLLER in (row["role"], row["member"]) for row in memberships):
            raise RestoreRefused("Memory controller membership requires separate approval")
        capabilities = contract.get("memoryControllerCapabilities")
        if (
            not isinstance(capabilities, list)
            or any(type(value) is not str for value in capabilities)
            or len(capabilities) != len(MEMORY_CONTROLLER_FUNCTIONS)
            or set(capabilities) != MEMORY_CONTROLLER_FUNCTIONS
        ):
            raise RestoreRefused("Memory controller capability contract mismatch")
    controllers = [r for r in contract["requiredRoles"] if r["name"] == WHATSAPP_VERIFIER]
    if controllers:
        if len(controllers) != 1 or any(
            controllers[0].get(flag) is not False for flag in ROLE_FLAGS
        ):
            raise RestoreRefused("WhatsApp verifier requires an inert least-privilege role")
        memberships = contract.get("roleMemberships")
        if not isinstance(memberships, list) or any(
            not isinstance(row, dict)
            or any(type(row.get(k)) is not str for k in ("role", "member"))
            or any(type(row.get(k)) is not bool for k in ("admin", "inherit", "set"))
            for row in memberships
        ):
            raise RestoreRefused("Complete role membership contract required")
        if any(WHATSAPP_VERIFIER in (row["role"], row["member"]) for row in memberships):
            raise RestoreRefused("WhatsApp verifier membership requires separate approval")
        capabilities = contract.get("whatsappVerifierCapabilities")
        if (
            not isinstance(capabilities, list)
            or any(type(value) is not str for value in capabilities)
            or len(capabilities) != len(WHATSAPP_VERIFIER_FUNCTIONS)
            or set(capabilities) != WHATSAPP_VERIFIER_FUNCTIONS
        ):
            raise RestoreRefused("WhatsApp verifier capability contract mismatch")


async def verify_role_contract(connection, contract: dict) -> None:
    """Check existing cluster roles; never create, grant or relax any role."""
    for role in contract["requiredRoles"]:
        name = role["name"]
        if not re.fullmatch(r"platform_[a-z_]+", name):
            raise RestoreRefused("Unexpected role contract")
        actual = await connection.fetchrow(
            "SELECT rolsuper,rolbypassrls,rolcanlogin,rolinherit,rolcreatedb,"
            "rolcreaterole,rolreplication FROM pg_roles WHERE rolname=$1",
            name,
        )
        if not actual or any(
            actual[column] != role[flag] for flag, column in ROLE_FLAGS.items() if flag in role
        ):
            raise RestoreRefused("Target roles do not match; explicit secure bootstrap required")
        if name != "platform_migrator" and (actual["rolsuper"] or actual["rolbypassrls"]):
            raise RestoreRefused("Runtime role may not bypass tenant isolation")
    if "roleMemberships" in contract:
        actual = await connection.fetch(
            "SELECT role.rolname AS role,member.rolname AS member,m.admin_option AS admin,"
            "m.inherit_option AS inherit,m.set_option AS set FROM pg_auth_members m "
            "JOIN pg_roles role ON role.oid=m.roleid JOIN pg_roles member ON member.oid=m.member "
            "WHERE role.rolname LIKE 'platform_%' OR member.rolname LIKE 'platform_%'"
        )
        canonical = lambda rows: sorted(  # noqa: E731 - local canonical tuple projection
            (r["role"], r["member"], r["admin"], r["inherit"], r["set"]) for r in rows
        )
        if canonical(actual) != canonical(contract["roleMemberships"]):
            raise RestoreRefused("Target role membership contract mismatch")


async def verify_evaluator_capabilities(connection) -> None:
    capabilities = await connection.fetch(
        "SELECT p.oid::regprocedure::text AS identity,acl.is_grantable FROM pg_proc p "
        "CROSS JOIN LATERAL aclexplode(p.proacl) acl "
        "JOIN pg_roles role ON role.oid=acl.grantee "
        "WHERE role.rolname=$1 AND acl.privilege_type='EXECUTE'",
        EVALUATOR,
    )
    if {r["identity"] for r in capabilities} != EVALUATOR_FUNCTIONS or any(
        r["is_grantable"] for r in capabilities
    ):
        raise RestoreRefused("Restored evaluator EXECUTE capability mismatch")
    extra = await connection.fetchval(
        "SELECT EXISTS(SELECT 1 FROM pg_class c "
        "CROSS JOIN LATERAL aclexplode(c.relacl) acl JOIN pg_roles r ON r.oid=acl.grantee "
        "WHERE r.rolname=$1) OR EXISTS(SELECT 1 FROM pg_namespace n "
        "CROSS JOIN LATERAL aclexplode(n.nspacl) acl JOIN pg_roles r ON r.oid=acl.grantee "
        "WHERE r.rolname=$1 AND (n.nspname<>'platform' OR acl.privilege_type<>'USAGE' "
        "OR acl.is_grantable)) OR NOT has_schema_privilege($1,'platform','USAGE') "
        "OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) acl "
        "WHERE p.oid::regprocedure::text=ANY($2::text[]) AND acl.grantee=0 "
        "AND acl.privilege_type='EXECUTE')",
        EVALUATOR,
        sorted(EVALUATOR_FUNCTIONS),
    )
    if extra:
        raise RestoreRefused("Restored evaluator has excess table/schema privileges")


async def verify_memory_controller_capabilities(connection) -> None:
    capabilities = await connection.fetch(
        "SELECT p.oid::regprocedure::text AS identity,acl.is_grantable FROM pg_proc p "
        "CROSS JOIN LATERAL aclexplode(p.proacl) acl JOIN pg_roles r ON r.oid=acl.grantee "
        "WHERE r.rolname=$1 AND acl.privilege_type='EXECUTE'",
        MEMORY_CONTROLLER,
    )
    if {r["identity"] for r in capabilities} != MEMORY_CONTROLLER_FUNCTIONS or any(
        r["is_grantable"] for r in capabilities
    ):
        raise RestoreRefused("Restored memory controller EXECUTE capability mismatch")
    extra = await connection.fetchval(
        "SELECT EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) acl "
        "JOIN pg_roles r ON r.oid=acl.grantee WHERE r.rolname=$1) "
        "OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) acl "
        "JOIN pg_roles r ON r.oid=acl.grantee WHERE r.rolname=$1 "
        "AND (n.nspname NOT IN ('agents','platform') OR acl.privilege_type<>'USAGE' "
        "OR acl.is_grantable)) "
        "OR NOT has_schema_privilege($1,'agents','USAGE') "
        "OR NOT has_schema_privilege($1,'platform','USAGE') "
        "OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) acl "
        "WHERE p.oid::regprocedure::text='agents.attest_real_memory_source(uuid,text)' "
        "AND acl.grantee=0 AND acl.privilege_type='EXECUTE')",
        MEMORY_CONTROLLER,
    )
    if extra:
        raise RestoreRefused("Restored memory controller has excess or PUBLIC privileges")


async def verify_whatsapp_verifier_capabilities(connection) -> None:
    capabilities = await connection.fetch(
        "SELECT p.oid::regprocedure::text AS identity,acl.is_grantable FROM pg_proc p "
        "CROSS JOIN LATERAL aclexplode(p.proacl) acl JOIN pg_roles r ON r.oid=acl.grantee "
        "WHERE r.rolname=$1 AND acl.privilege_type='EXECUTE'",
        WHATSAPP_VERIFIER,
    )
    if {r["identity"] for r in capabilities} != WHATSAPP_VERIFIER_FUNCTIONS or any(
        r["is_grantable"] for r in capabilities
    ):
        raise RestoreRefused("Restored WhatsApp verifier EXECUTE capability mismatch")
    extra = await connection.fetchval(
        "SELECT EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) acl "
        "JOIN pg_roles r ON r.oid=acl.grantee WHERE r.rolname=$1) "
        "OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) acl "
        "JOIN pg_roles r ON r.oid=acl.grantee WHERE r.rolname=$1 "
        "AND (n.nspname <>'agents' OR acl.privilege_type<>'USAGE' "
        "OR acl.is_grantable)) "
        "OR NOT has_schema_privilege($1,'agents','USAGE') "
        "OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) acl "
        "WHERE p.oid::regprocedure::text='agents.attest_whatsapp_signature(uuid,text,jsonb)' "
        "AND acl.grantee=0 AND acl.privilege_type='EXECUTE')",
        WHATSAPP_VERIFIER,
    )
    if extra:
        raise RestoreRefused("Restored WhatsApp verifier has excess or PUBLIC privileges")


async def create_target(dsn: str, target: str, contract: dict) -> None:
    import asyncpg

    validate_security_contract(contract)
    parsed = urlsplit(dsn)
    connection = await asyncpg.connect(urlunsplit(parsed._replace(path="/postgres")))
    try:
        roles = contract.get("requiredRoles")
        if not isinstance(roles, list) or not roles:
            raise RestoreRefused("Role contract missing")
        await verify_role_contract(connection, contract)
        if await connection.fetchval(
            "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)", target
        ):
            raise RestoreRefused("Target database already exists; never overwrite")
        await connection.execute(f'CREATE DATABASE "{target}"')
    finally:
        await connection.close()


async def verify_database(dsn: str, manifest: dict, contract: dict) -> None:
    import asyncpg

    connection = await asyncpg.connect(dsn)
    try:
        await verify_role_contract(connection, contract)
        if "evaluatorCapabilities" in contract and any(
            role["name"] == EVALUATOR for role in contract["requiredRoles"]
        ):
            await verify_evaluator_capabilities(connection)
        if any(role["name"] == MEMORY_CONTROLLER for role in contract["requiredRoles"]):
            await verify_memory_controller_capabilities(connection)
        if any(role["name"] == WHATSAPP_VERIFIER for role in contract["requiredRoles"]):
            await verify_whatsapp_verifier_capabilities(connection)
        heads = await connection.fetch("SELECT version_num FROM alembic_version")
        if len(heads) != 1 or heads[0]["version_num"] != manifest["schemaHead"]:
            raise RestoreRefused("Restored schema head mismatch")
        for table in contract["protectedTables"]:
            actual = await connection.fetchrow(
                "SELECT relrowsecurity,relforcerowsecurity FROM pg_class c "
                "JOIN pg_namespace n ON n.oid=c.relnamespace "
                "WHERE n.nspname=$1 AND c.relname=$2",
                table["schema"],
                table["name"],
            )
            if not actual or tuple(actual) != (table["rls"], table["forceRls"]):
                raise RestoreRefused("Restored RLS/FORCE RLS contract mismatch")
        for function in contract["functionOwners"]:
            actual = await connection.fetchval(
                "SELECT r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner "
                "WHERE p.oid=to_regprocedure($1)",
                function["identity"],
            )
            if actual != function["owner"]:
                raise RestoreRefused("Restored function ownership contract mismatch")
        bad = await connection.fetchval(
            "SELECT count(*) FROM pg_constraint WHERE contype IN ('f','c') AND NOT convalidated"
        )
        if bad:
            raise RestoreRefused("Restored database has unvalidated constraints")
    finally:
        await connection.close()


def _verify_object_files(rows, root: Path) -> None:
    resolved_root = root.resolve()
    for row in rows:
        key = row["storage_key"]
        path = root.joinpath(*PurePosixPath(key).parts).resolve()
        if (
            "\\" in key
            or PurePosixPath(key).is_absolute()
            or not path.is_relative_to(resolved_root)
            or not path.is_file()
            or path.stat().st_size != row["byte_size"]
        ):
            raise RestoreRefused("Restored private object reference or size mismatch")
        with path.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != row["checksum"]:
            raise RestoreRefused("Restored private object checksum mismatch")


async def verify_object_references(dsn: str, root: Path) -> None:
    import asyncpg

    connection = await asyncpg.connect(dsn)
    try:
        rows = await connection.fetch(
            "SELECT storage_key,byte_size,checksum FROM objects.object_metadata "
            "WHERE status='available' AND deleted_at IS NULL AND storage_backend='local'"
        )
    finally:
        await connection.close()
    await asyncio.to_thread(_verify_object_files, rows, root)


def run_restore(args: argparse.Namespace) -> dict:
    dsn = os.environ.get("ORON_RESTORE_DATABASE_URL", "")
    with tempfile.TemporaryDirectory(prefix="oron-restore-") as temporary:
        staging = Path(temporary)
        manifest = validate_archive(
            args.archive, args.expected_sha256, staging, args.max_expanded_bytes
        )
        target_dsn = validate_target(
            dsn, args.target_database, args.confirm_new_database, manifest["database"]
        )
        contract = json.loads((staging / "security-contract.json").read_text())
        validate_security_contract(contract)
        if manifest["objectsIncluded"]:
            if args.objects_directory is None:
                raise RestoreRefused("Full restore requires an explicit fresh object directory")
            if args.objects_directory.exists():
                raise RestoreRefused("Object target already exists; never merge or overwrite")
            if args.objects_directory.parent.resolve() != args.objects_directory.parent.absolute():
                raise RestoreRefused("Object target parent may not contain symlinks")
        asyncio.run(create_target(dsn, args.target_database, contract))
        parsed = urlsplit(dsn)
        environment = {
            **os.environ,
            "PGHOST": parsed.hostname or "",
            "PGPORT": str(parsed.port),
            "PGUSER": unquote(parsed.username or ""),
            "PGPASSWORD": unquote(parsed.password or ""),
        }
        result = subprocess.run(  # noqa: S603 - operator-selected PostgreSQL client; fixed arguments
            [
                str(args.pg_restore),
                "--exit-on-error",
                "--single-transaction",
                "--dbname",
                args.target_database,
                str(staging / "database.dump"),
            ],
            env=environment,
            capture_output=True,
            timeout=300,
            check=False,
        )
        if result.returncode:
            raise RestoreRefused("pg_restore failed; fresh database retained for diagnosis")
        asyncio.run(verify_database(target_dsn, manifest, contract))
        if manifest["objectsIncluded"]:
            args.objects_directory.mkdir(mode=0o700)
            with tarfile.open(staging / "objects.tar") as objects:
                objects.extractall(
                    args.objects_directory,
                    members=safe_members(objects, args.max_expanded_bytes),
                    filter="data",
                )
            asyncio.run(verify_object_references(target_dsn, args.objects_directory))
        return {
            "status": "PASS",
            "database": args.target_database,
            "schemaHead": manifest["schemaHead"],
            "objectsRestored": manifest["objectsIncluded"],
            "securityContractVerified": True,
            "keyEscrowVerified": False,
            "scope": "owned_local_fixture",
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--target-database", required=True)
    parser.add_argument("--confirm-new-database", required=True)
    parser.add_argument("--pg-restore", type=Path, required=True)
    parser.add_argument("--objects-directory", type=Path)
    parser.add_argument("--max-expanded-bytes", type=int, default=1024**3)
    args = parser.parse_args()
    try:
        if args.max_expanded_bytes < 1 or args.max_expanded_bytes > 80 * 1024**3:
            raise RestoreRefused("Invalid expanded-size limit")
        print(json.dumps(run_restore(args), sort_keys=True))
        return 0
    except Exception:  # noqa: BLE001 - CLI must not expose credentials from driver errors
        print(
            "Restore refused or failed; no shared database was selected. "
            "Inspect the owned target privately."
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
