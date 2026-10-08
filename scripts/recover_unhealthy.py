"""Opt-in, bounded recovery of allowlisted application containers only.

Never installed/enabled by deployment. Default invocation reports a plan only.
No container logs, inspect documents, credentials or customer status are printed.
"""

from __future__ import annotations

import argparse
import importlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Protocol, TextIO, cast

SERVICES = frozenset({"messaging-worker", "web", "caddy"})
ROOT = Path("/opt/oron-dev")
COOLDOWN_SECONDS = 300
WINDOW_SECONDS = 900
MAX_RESTARTS = 2


def eligible(service: str, state: dict, attempts: list[int], now: int) -> bool:
    """Do not restart stopped/missing/starting containers or amplify outages."""
    recent = [value for value in attempts if now - WINDOW_SECONDS <= value <= now]
    return (
        service in SERVICES
        and state.get("Status") == "running"
        and state.get("Health", {}).get("Status") == "unhealthy"
        and len(recent) < MAX_RESTARTS
        and not any(now - value < COOLDOWN_SECONDS for value in recent)
        and not any(value > now for value in attempts)
    )


def command(arguments: list[str]) -> str:
    result = subprocess.run(  # noqa: S603 - fixed Docker CLI, closed service allowlist
        ["/usr/bin/docker", *arguments],
        check=True,
        capture_output=True,
        text=True,
        timeout=100,
    )
    return result.stdout.strip()


def validate_state(state: dict, now: int) -> None:
    """Reject corrupted history globally before taking any action."""
    if set(state) - SERVICES:
        raise ValueError("Invalid recovery state")
    for attempts in state.values():
        if not isinstance(attempts, list) or any(
            type(value) is not int or value < 0 or value > now for value in attempts
        ):
            raise ValueError("Invalid recovery state")


def inspect_state(compose: list[str], service: str) -> dict:
    identifier = command([*compose, "ps", "--quiet", service])
    if not identifier:
        return {}
    if not re.fullmatch(r"[a-f0-9]{12,64}", identifier):
        raise ValueError("Unexpected container identity")
    # Only status fields: Docker health logs may contain credentials/errors.
    status = command(["inspect", "--format", "{{.State.Status}}", identifier])
    health = command(
        [
            "inspect",
            "--format",
            "{{if .State.Health}}{{.State.Health.Status}}{{end}}",
            identifier,
        ]
    )
    return {"Status": status, "Health": {"Status": health}}


def schema_matches_release(compose: list[str]) -> bool:
    """An advanced/unknown DB must never restart an older application image."""
    try:
        manifest = json.loads((ROOT / "current/db/contracts/schema-manifest.json").read_text())
        expected = manifest["alembic_head"]
        if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{12}", expected):
            return False
        result = subprocess.run(  # noqa: S603 - fixed read-only SQL and closed Docker command
            [
                "/usr/bin/docker",
                *compose,
                "exec",
                "-T",
                "postgres",
                "sh",
                "-c",
                'PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=5000" '
                'psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" '
                '-c "SELECT version_num FROM alembic_version;"',
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        actual = result.stdout.strip()
        return bool(re.fullmatch(r"[0-9a-f]{12}", actual)) and actual == expected
    except Exception:
        # Missing manifest, failed probe and multiple heads all fail closed.
        return False


def recover(
    compose: list[str],
    state_path: Path,
    state: dict,
    now: int,
    *,
    apply: bool = False,
) -> None:
    validate_state(state, now)
    database = inspect_state(compose, "postgres")
    database_healthy = (
        database.get("Status") == "running"
        and database.get("Health", {}).get("Status") == "healthy"
    )
    compatible = database_healthy and schema_matches_release(compose)
    for service in sorted(SERVICES):
        if service != "caddy" and not compatible:
            continue
        attempts = state.get(service, [])
        container = inspect_state(compose, service)
        if not eligible(service, container, attempts, now):
            continue
        print(f"{service}: {'restart' if apply else 'restart eligible (dry-run)'}")
        if apply:
            # Failed commands also consume budget, persisted before restart.
            state[service] = [value for value in attempts if value >= now - WINDOW_SECONDS]
            state[service].append(now)
            temporary = state_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(state), encoding="utf8")
            temporary.chmod(0o600)
            temporary.replace(state_path)
            grace = "90" if service == "messaging-worker" else "45"
            command([*compose, "restart", "--no-deps", "--timeout", grace, service])


class LinuxFileLock(Protocol):
    """The Linux-only boundary; Windows typeshed intentionally omits fcntl members."""

    LOCK_EX: int
    LOCK_NB: int

    def flock(self, file: TextIO, operation: int, /) -> None: ...


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Explicitly enable bounded restarts")
    options = parser.parse_args()
    if sys.platform != "linux":
        raise RuntimeError("Deployment recovery requires a Linux host")
    # Share the deploy lock: never interfere with migration/rollback/service drain.
    fcntl = cast(LinuxFileLock, importlib.import_module("fcntl"))

    with Path("/run/lock/oron-dev-deploy.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state_path = ROOT / "shared/recovery-state.json"
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        if not isinstance(state, dict):
            raise ValueError("Invalid recovery state")
        compose = [
            "compose",
            "--env-file",
            str(ROOT / "shared/deployment.env"),
            "--env-file",
            str(ROOT / "current/images.env"),
            "--file",
            str(ROOT / "current/infra/compose/deployment.yaml"),
            "--profile",
            "workers",
            "--profile",
            "voice",
        ]
        recover(compose, state_path, state, int(time.time()), apply=options.apply)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Driver/CLI exceptions can contain private configuration; never render them.
        raise SystemExit("Recovery check failed; operator inspection required") from None
