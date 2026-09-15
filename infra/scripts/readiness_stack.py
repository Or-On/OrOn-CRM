"""Disposable production-image acceptance; no .env, provider secrets or developer volumes.

Only owns project oron-readiness-stack and ignored
.artifacts/readiness/post-implementation-stack.
Deliberately does not remove volumes/containers automatically, preserving failure evidence.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import tarfile
import time
import urllib.request
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / ".artifacts/readiness/post-implementation-stack"
CONFIG = ARTIFACTS / "config"
PROJECT = "oron-readiness-stack"


def environment() -> dict[str, str]:
    # Do not inherit application credentials or proxy configuration from the invoking shell.
    result = {
        key: value
        for key, value in os.environ.items()
        if key.upper()
        in {
            "PATH",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "HOME",
            "APPDATA",
            "LOCALAPPDATA",
            "COMSPEC",
            "PATHEXT",
        }
    }
    result.update(
        {
            "COMPOSE_DISABLE_ENV_FILE": "1",
            "DEPLOYMENT_CONFIG_DIR": str(CONFIG),
            "DEPLOYMENT_DATA_DIR": str(ARTIFACTS / "data"),
            "DEPLOYMENT_DATABASE_NAME": "oron_staging",
            "WEB_IMAGE": "oron-readiness/web:candidate",
            "CONTROL_API_IMAGE": "oron-readiness/control-api:candidate",
            "MESSAGING_WORKER_IMAGE": "oron-readiness/messaging-worker:candidate",
            "DISPATCHER_IMAGE": "oron-readiness/dispatcher:candidate",
            "MIGRATOR_IMAGE": "oron-readiness/migrator:candidate",
            "PLATFORM_ORIGIN": "http://127.0.0.1:13880",
            "TLS_CONTACT_EMAIL": "readiness@example.invalid",
        }
    )
    return result


def compose(*args: str, output=None, input_file=None, web_image: str | None = None) -> bytes:
    env = environment()
    if web_image is not None:
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", web_image):
            raise ValueError("Rollback rehearsal requires an exact local web image ID")
        inspected = subprocess.run(  # noqa: S603
            [shutil.which("docker") or "docker", "image", "inspect", web_image],
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )
        tags = json.loads(inspected.stdout)[0].get("RepoTags", [])
        if "oron-readiness/web:rollback-checkpoint" not in tags:
            raise ValueError("Only the explicitly tagged disposable web checkpoint is permitted")
        env["WEB_IMAGE"] = web_image
    context = subprocess.run(  # noqa: S603
        [
            shutil.which("docker") or "docker",
            "context",
            "inspect",
            "--format",
            "{{json .Endpoints.docker.Host}}",
        ],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    endpoint = json.loads(context.stdout)
    if not endpoint.startswith(("unix://", "npipe://")):
        raise ValueError(
            "Disposable acceptance requires a local Docker engine, not a remote context"
        )
    result = subprocess.run(  # noqa: S603
        [
            shutil.which("docker") or "docker",
            "compose",
            "-p",
            PROJECT,
            "-f",
            str(ROOT / "infra/compose/deployment.yaml"),
            "-f",
            str(ROOT / "infra/compose/readiness.local.yaml"),
            "--profile",
            "release",
            "--profile",
            "bootstrap",
            "--profile",
            "workers",
            "--profile",
            "voice",
            *args,
        ],
        env=env,
        check=True,
        stdin=input_file,
        stdout=output if output is not None else subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return result.stdout or b""


def prepare() -> None:
    if CONFIG.exists():
        raise ValueError("Fixture config already exists; keep it for the same disposable cluster")
    CONFIG.mkdir(parents=True, mode=0o700)
    for directory in (
        ARTIFACTS / "data/postgres",
        ARTIFACTS / "data/caddy",
        ARTIFACTS / "data/objects",
    ):
        directory.mkdir(parents=True, exist_ok=True)
    password = secrets.token_hex(24)
    pepper, service = secrets.token_hex(32), secrets.token_hex(32)
    field_key = base64.b64encode(os.urandom(32)).decode()
    # Structurally valid dummy hash. There are no seeded users and no login bypass.
    dummy = "$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHRzb21lc2FsdA$" + "A" * 43
    roles = {
        name: secrets.token_hex(24)
        for name in ("platform_web", "platform_voice", "platform_messaging")
    }

    def dsn(role: str) -> str:
        return f"postgresql://{role}:{roles[role]}@postgres:5432/oron_staging"

    files = {
        "postgres-password.txt": password,
        "migrator.env": "\n".join(
            [
                f"DATABASE_URL=postgresql://platform_migrator:{password}@postgres:5432/oron_staging",
                *(f"{role.upper()}_PASSWORD={value}" for role, value in roles.items()),
            ]
        ),
        "web.env": "\n".join(
            [
                f"DATABASE_URL={dsn('platform_web')}",
                f"AUTH_TOKEN_PEPPER={pepper}",
                f"AUTH_SERVICE_SECRET={service}",
                f"AUTH_DUMMY_PASSWORD_HASH={dummy}",
            ]
        ),
        "control-api.env": "\n".join(
            [
                f"DATABASE_URL={dsn('platform_web')}",
                f"VOICE_DATABASE_URL={dsn('platform_voice')}",
                f"AUTH_SERVICE_SECRET={service}",
            ]
        ),
        "dispatcher.env": "\n".join(
            [
                f"VOICE_DATABASE_URL={dsn('platform_voice')}",
                f"AUTH_SERVICE_SECRET={service}",
                f"FIELD_CIPHER_LOCAL_KEY={field_key}",
                f"BLIND_INDEX_KEY={field_key}",
                "ARTIFACTS_BACKEND=local",
                "ARTIFACTS_LOCAL_ROOT=/var/lib/oron/objects",
            ]
        ),
        "messaging-worker.env": "\n".join(
            [
                f"MESSAGING_DATABASE_URL={dsn('platform_messaging')}",
                f"AUTH_SERVICE_SECRET={service}",
            ]
        ),
        "bootstrap-owner.env": "\n".join(
            [
                f"MIGRATION_DATABASE_URL=postgresql://platform_migrator:{password}@postgres:5432/oron_staging",
                "BOOTSTRAP_OWNER_EMAIL=operator@example.invalid",
                "BOOTSTRAP_TENANT_NAME=Fictional readiness workspace",
                "BOOTSTRAP_TENANT_SLUG=fictional-readiness",
            ]
        ),
    }
    for filename, value in files.items():
        descriptor = os.open(CONFIG / filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            output.write(value + "\n")
    password_file = CONFIG / "owner-password.txt"
    descriptor = os.open(password_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(secrets.token_urlsafe(24) + "\n")
    print("Created fictional private fixture configuration. No account or business records seeded.")


def sql(query: str, database: str = "oron_staging") -> str:
    return (
        compose(
            "exec",
            "-T",
            "postgres",
            "psql",
            "-U",
            "platform_migrator",
            "-d",
            database,
            "-At",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            query,
        )
        .decode()
        .strip()
    )


def smoke() -> dict:
    checks = {}
    for path in ("/login", "/api/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=fictional"):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:13880{path}", timeout=10) as response:  # noqa: S310
                checks[path.split("?")[0]] = response.status
        except urllib.error.HTTPError as error:
            checks[path.split("?")[0]] = error.code
    if checks["/login"] != 200 or checks["/api/webhooks/whatsapp"] != 404:
        raise ValueError("HTTP acceptance failed")
    checks["head"] = sql("SELECT version_num FROM alembic_version")
    checks["users"] = sql("SELECT count(*) FROM users")
    checks["runtime_roles_unsafe"] = sql(
        "SELECT count(*) FROM pg_roles WHERE rolname IN "
        "('platform_web','platform_voice','platform_messaging') "
        "AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole)"
    )
    if checks["users"] != "0" or checks["runtime_roles_unsafe"] != "0":
        raise ValueError("Clean startup/no demo users/least-privilege acceptance failed")
    return checks


def recovery() -> dict:
    start = time.monotonic()
    tenant, contact = str(uuid4()), str(uuid4())
    # Fictional data ONLY in this script's fixed disposable Compose project.
    sql(
        f"INSERT INTO tenants(id,name,slug) VALUES ('{tenant}',"  # noqa: S608
        f"'Recovery fixture','recovery-{tenant}'); "
        f"INSERT INTO crm.contacts(id,tenant_id,name) VALUES ('{contact}','{tenant}',"
        "'Fictional recovery contact');"
    )
    archive = ARTIFACTS / f"recovery-{time.time_ns()}.dump"
    with archive.open("xb") as output:
        compose(
            "exec",
            "-T",
            "postgres",
            "pg_dump",
            "-U",
            "platform_migrator",
            "-Fc",
            "--no-owner",
            "oron_staging",
            output=output,
        )
    with archive.open("rb") as source:
        checksum = hashlib.file_digest(source, "sha256").hexdigest()
    database = f"oron_restore_{secrets.token_hex(8)}"
    compose("exec", "-T", "postgres", "createdb", "-U", "platform_migrator", database)
    with archive.open("rb") as source:
        compose(
            "exec",
            "-T",
            "postgres",
            "pg_restore",
            "-U",
            "platform_migrator",
            "--exit-on-error",
            "--single-transaction",
            "--no-owner",
            "-d",
            database,
            input_file=source,
        )
    shape = (
        "SELECT count(*) FROM pg_class WHERE relkind='r' AND relnamespace IN "
        "(SELECT oid FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' "
        "AND nspname <> 'information_schema')"
    )
    rls = "SELECT count(*) FROM pg_class WHERE relrowsecurity AND relforcerowsecurity"
    for query in (
        shape,
        rls,
        "SELECT version_num FROM alembic_version",
        "SELECT count(*) FROM tenants",
        "SELECT count(*) FROM crm.contacts",
    ):
        if sql(query) != sql(query, database):
            raise ValueError("Restore integrity comparison failed")
    if sql(f"SELECT name FROM crm.contacts WHERE id='{contact}'", database) != (  # noqa: S608
        "Fictional recovery contact"
    ):
        raise ValueError("Restored contact content mismatch")
    # UUID is generated locally, never external input.
    scoped = (
        "BEGIN; SET LOCAL ROLE platform_web; "  # noqa: S608
        f"SET LOCAL app.current_tenant='{tenant}'; "
        "SELECT count(*) FROM crm.contacts; ROLLBACK"
    )
    # psql emits command tags around the one row count; require both restored/context parity.
    if sql(scoped) != sql(scoped, database):
        raise ValueError("Restored runtime-role RLS result differs")
    object_source = ARTIFACTS / "data/objects/readiness" / f"{contact}.bin"
    object_source.parent.mkdir(parents=True, exist_ok=True)
    object_source.write_bytes(b"fictional-private-object-recovery-fixture")
    object_archive = ARTIFACTS / f"recovery-objects-{time.time_ns()}.tar"
    with tarfile.open(object_archive, "w") as output:
        output.add(object_source, arcname=f"objects/readiness/{contact}.bin")
    object_restore = ARTIFACTS / f"restore-objects-{secrets.token_hex(8)}"
    object_restore.mkdir()
    with tarfile.open(object_archive) as source:
        source.extractall(object_restore, filter="data")
    restored_object = object_restore / f"objects/readiness/{contact}.bin"
    if restored_object.read_bytes() != object_source.read_bytes():
        raise ValueError("Restored private object content mismatch")
    object_checksum = hashlib.sha256(object_source.read_bytes()).hexdigest()
    return {
        "seconds": round(time.monotonic() - start, 3),
        "sha256": checksum,
        "bytes": archive.stat().st_size,
        "database": database,
        "object_archive": object_archive.name,
        "object_sha256": object_checksum,
        "scope": (
            "schema/table counts/head/forced RLS plus fictional contact content "
            "and runtime-role RLS plus one synthetic private object"
        ),
        "workers_replayed": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=(
            "prepare",
            "validate",
            "start",
            "check",
            "restart",
            "recover",
            "fault-check",
            "rollback-check",
            "stop",
        ),
    )
    parser.add_argument("--previous-web-image")
    args = parser.parse_args()
    if args.action == "prepare":
        prepare()
        return
    if args.action == "validate":
        compose("config", "--quiet")
        compose(
            "run",
            "--rm",
            "--no-deps",
            "caddy",
            "caddy",
            "validate",
            "--config",
            "/etc/caddy/Caddyfile",
        )
    if args.action == "start":
        compose("up", "-d", "--wait", "postgres")
        compose("run", "--rm", "--no-deps", "migrator")
        compose("up", "-d", "--wait", "web", "control-api", "caddy")
    if args.action == "restart":
        compose("restart", "postgres", "control-api", "web")
        compose("up", "-d", "--wait", "web", "control-api", "caddy")
    if args.action == "fault-check":
        try:
            compose("stop", "postgres")
            check = (
                "import urllib.request,urllib.error\n"
                "try:\n urllib.request.urlopen('http://127.0.0.1:8000/health/ready',timeout=15)\n"
                "except urllib.error.HTTPError as e:\n assert e.code==503\n"
                "else:\n raise AssertionError('Database outage incorrectly reported ready')"
            )
            compose("exec", "-T", "control-api", "python", "-c", check)
        finally:
            compose("up", "-d", "--wait", "postgres", "control-api", "web", "caddy")
    if args.action == "rollback-check":
        if not args.previous_web_image:
            raise ValueError("An explicit disposable previous web image is required")
        before = smoke()
        try:
            compose(
                "up",
                "-d",
                "--wait",
                "--no-deps",
                "web",
                web_image=args.previous_web_image,
            )
            rolled_back = smoke()
            if rolled_back != before:
                raise ValueError("Previous web image changed schema or startup invariants")
        finally:
            compose("up", "-d", "--wait", "--no-deps", "web")
        evidence = {
            **smoke(),
            "previous_web_image": args.previous_web_image,
            "schema_downgraded": False,
            "scope": "web image rollback and forward, HTTP/role/schema smoke only",
            "authenticated_workflows": "pending separate acceptance",
        }
    elif args.action in ("start", "check", "restart", "fault-check"):
        evidence = smoke()
    elif args.action == "recover":
        evidence = recovery()
    else:
        evidence = {"action": args.action, "passed": True}
    if args.action == "stop":
        compose("stop")
    (ARTIFACTS / f"{args.action}.json").write_text(json.dumps(evidence, indent=2))
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        # Only local fake configuration is present, but retain a consistent no-secrets log boundary.
        print(f"Isolated stack command failed ({error.returncode}); inspect test containers only.")
        raise SystemExit(1) from None
