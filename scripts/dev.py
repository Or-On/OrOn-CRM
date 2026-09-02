"""Cross-platform implementation of the repository's human command surface."""

from __future__ import annotations

import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
from collections.abc import Callable, Sequence
from contextlib import suppress
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Keep direct `python scripts/dev.py ...` invocation compatible with imports from
# the repository's scripts namespace. Module invocation already includes ROOT.
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
ENV_FILE = ROOT / ".env"
ENV_EXAMPLE = ROOT / ".env.example"
COMPOSE_FILE = ROOT / "infra" / "compose" / "compose.yaml"
PYTHON_PATHS = ("packages/py", "services/py", "db", "scripts")
PYTHON_TYPE_PATHS = (
    "packages/py/oron-common/src",
    "packages/py/oron-db/src",
    "packages/py/oron-flows/src",
    "packages/py/oron-hebrew/src",
    "packages/py/oron-agent/src",
    "packages/py/oron-secrets/src",
    "packages/py/oron-sessions/src",
    "packages/py/oron-tenancy/src",
    "packages/py/platform-integration/src",
    "services/py/control-api/src",
    "services/py/dispatcher/src",
    "services/py/voice-agent/src",
    "db/importers",
    "db/alembic/env.py",
    "db/alembic/oron_migration_compat.py",
    "db/seeds",
    "scripts",
)


def _run(
    command: Sequence[str],
    *,
    environment: dict[str, str] | None = None,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    print(f"+ {' '.join(command)}", flush=True)
    # Commands are fixed by the action table; no shell or untrusted argv is used.
    return subprocess.run(  # noqa: S603
        _resolve_command(command),
        cwd=ROOT,
        env=environment,
        check=True,
        text=True,
        capture_output=capture,
    )


def _resolve_command(command: Sequence[str]) -> list[str]:
    """Resolve Windows command shims without enabling a general-purpose shell."""

    executable = shutil.which(command[0])
    if executable is None:
        return list(command)
    resolved = [executable, *command[1:]]
    if os.name == "nt" and Path(executable).suffix.lower() in {".bat", ".cmd"}:
        command_line = subprocess.list2cmdline(resolved)
        return [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c", command_line]
    return resolved


def _load_environment(*, create: bool = False) -> dict[str, str]:
    if create and not ENV_FILE.exists():
        shutil.copyfile(ENV_EXAMPLE, ENV_FILE)
        print("Created ignored .env from .env.example")
    result = dict(os.environ)
    if not ENV_FILE.exists():
        return result
    for raw_line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", maxsplit=1)
        # A repository-local environment file is the explicit configuration for
        # this developer command surface. It must override unrelated ambient
        # variables so bootstrap cannot accidentally target another project.
        result[key.strip()] = value.strip().strip('"').strip("'")
    return result


def _require_provider_safety(environment: dict[str, str]) -> None:
    enabled = {
        key
        for key in (
            "ENABLE_REAL_TELEPHONY",
            "ENABLE_REAL_WHATSAPP",
            "ENABLE_REAL_VOICE_PROVIDERS",
        )
        if environment.get(key, "false").strip().lower() != "false"
    }
    if enabled:
        names = ", ".join(sorted(enabled))
        raise RuntimeError(f"Phase 1 refuses real-provider flags: {names} must be false")


def _require_non_whatsapp_provider_safety(environment: dict[str, str]) -> None:
    enabled = {
        key
        for key in ("ENABLE_REAL_TELEPHONY", "ENABLE_REAL_VOICE_PROVIDERS")
        if environment.get(key, "false").strip().lower() != "false"
    }
    if enabled:
        names = ", ".join(sorted(enabled))
        raise RuntimeError(f"development refuses unsafe provider flags: {names} must be false")


def _compose(*arguments: str, profile: str = "core") -> list[str]:
    return [
        "docker",
        "compose",
        "--env-file",
        str(ENV_FILE),
        "-f",
        str(COMPOSE_FILE),
        "--profile",
        profile,
        *arguments,
    ]


def _migration_environment(environment: dict[str, str]) -> dict[str, str]:
    migration_url = environment.get("MIGRATION_DATABASE_URL")
    if not migration_url:
        raise RuntimeError("MIGRATION_DATABASE_URL is required for Alembic and seed commands")
    result = dict(environment)
    result["DATABASE_URL"] = migration_url
    return result


def _version(command: Sequence[str]) -> str | None:
    try:
        # Doctor calls only the fixed tool/version commands declared below.
        completed = subprocess.run(  # noqa: S603
            _resolve_command(command),
            cwd=ROOT,
            check=False,
            text=True,
            capture_output=True,
            timeout=10,
        )
    except FileNotFoundError, subprocess.TimeoutExpired:
        return None
    output = (completed.stdout or completed.stderr).strip().splitlines()
    return output[0] if completed.returncode == 0 and output else None


def _numeric_version(value: str | None) -> tuple[int, ...] | None:
    if value is None:
        return None
    match = re.search(r"(\d+)(?:\.(\d+))?(?:\.(\d+))?", value)
    return tuple(int(part) for part in match.groups(default="0")) if match else None


def _supported_compose_version(version: tuple[int, ...]) -> bool:
    """Accept the Compose v2 plugin command surface and later compatible majors."""

    return version >= (2, 0)


def _check_tool(
    name: str,
    command: Sequence[str],
    requirement: str,
    predicate: Callable[[tuple[int, ...]], bool] | None = None,
) -> tuple[str, bool]:
    value = _version(command)
    parsed = _numeric_version(value)
    passed = value is not None and (predicate is None or (parsed is not None and predicate(parsed)))
    rendered = value or "not found"
    return (
        f"{name:16} {'PASS' if passed else 'FAIL':4} detected={rendered} required={requirement}",
        passed,
    )


def doctor() -> None:
    checks = [
        _check_tool("Git", ["git", "--version"], "installed"),
        _check_tool("Docker", ["docker", "--version"], "Engine/Desktop available"),
        _check_tool(
            "Compose",
            ["docker", "compose", "version"],
            "Compose >=2",
            _supported_compose_version,
        ),
        _check_tool(
            "Node.js", ["node", "--version"], ">=24.20,<25", lambda v: (24, 20) <= v < (25, 0)
        ),
        _check_tool(
            "pnpm", ["pnpm", "--version"], ">=11.24,<12", lambda v: (11, 24) <= v < (12, 0)
        ),
        _check_tool(
            "Python",
            ["uv", "run", "python", "--version"],
            ">=3.14.7,<3.15 via uv",
            lambda v: (3, 14, 7) <= v < (3, 15),
        ),
        _check_tool(
            "uv", ["uv", "--version"], ">=0.12.7,<0.13", lambda v: (0, 12, 7) <= v < (0, 13)
        ),
        _check_tool("GNU Make", ["make", "--version"], "installed"),
    ]
    daemon = _version(["docker", "info", "--format", "{{.ServerVersion}}"])
    checks.append(
        (
            f"{'Docker daemon':16} {'PASS' if daemon else 'FAIL':4} "
            f"detected={daemon or 'unavailable'} required=running",
            daemon is not None,
        )
    )
    print("Or-On Platform doctor")
    for line, _ in checks:
        print(line)
    for port in (3000, 5433, 8000, 8787):
        with socket.socket() as probe:
            in_use = probe.connect_ex(("127.0.0.1", port)) == 0
        state = "in use" if in_use else "available"
        print(f"port {port:<11} {'WARN' if in_use else 'PASS':4} {state}")
    print("GCP, gcloud, Terraform, and provider credentials are not localhost prerequisites.")
    if not all(passed for _, passed in checks):
        raise RuntimeError("doctor found missing or incompatible required tools")


def _bootstrap_roles(environment: dict[str, str]) -> None:
    user = environment.get("POSTGRES_USER", "platform_migrator")
    database = environment.get("POSTGRES_DB", "or_on_platform_dev")
    _run(
        _compose(
            "exec",
            "-T",
            "postgres",
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            user,
            "-d",
            database,
            "-f",
            "/docker-entrypoint-initdb.d/010-development-roles.sql",
        ),
        environment=environment,
    )


def migrate(environment: dict[str, str]) -> None:
    _run(
        ["uv", "run", "alembic", "-c", "db/alembic/alembic.ini", "upgrade", "head"],
        environment=_migration_environment(environment),
    )


def migration_check(environment: dict[str, str]) -> None:
    migration_env = _migration_environment(environment)
    _run(
        ["uv", "run", "pytest", "-p", "no:cacheprovider", "db/tests/test_migration_graph.py"],
        environment=migration_env,
    )
    _run(
        [
            "uv",
            "run",
            "alembic",
            "-c",
            "db/alembic/alembic.ini",
            "current",
            "--check-heads",
        ],
        environment=migration_env,
    )


def migration_graph() -> None:
    _run(["uv", "run", "python", "scripts/db_verify.py", "graph"])


def migration_sql() -> None:
    _run(["uv", "run", "python", "scripts/db_verify.py", "sql"])


def db_contract_check() -> None:
    _run(["uv", "run", "python", "scripts/db_verify.py", "contract"])


def db_verify_offline(environment: dict[str, str]) -> None:
    _require_provider_safety(environment)
    _run(["uv", "run", "python", "scripts/db_verify.py", "offline"], environment=environment)
    _run(
        [
            "uv",
            "run",
            "pytest",
            "-p",
            "no:cacheprovider",
            "db/tests/test_migration_graph.py",
            "db/importers/openlive_legacy/tests",
            "db/importers/wacrm_legacy/tests",
            "scripts/tests/test_db_verify.py",
        ],
        environment=environment,
    )
    _run(["uv", "run", "python", "scripts/check_repository.py"], environment=environment)
    _run(["pnpm", "contracts:check"], environment=environment)


def db_verify_live(environment: dict[str, str]) -> None:
    _require_provider_safety(environment)
    database_url = environment.get("TEST_DATABASE_URL") or environment.get("MIGRATION_DATABASE_URL")
    if not database_url:
        raise RuntimeError(
            "db-verify-live requires TEST_DATABASE_URL or MIGRATION_DATABASE_URL "
            "for an isolated PostgreSQL 18.6 database"
        )
    live_environment = dict(environment)
    live_environment["DATABASE_URL"] = database_url
    live_environment["TEST_DATABASE_URL"] = database_url
    _run(
        ["uv", "run", "alembic", "-c", "db/alembic/alembic.ini", "upgrade", "head"],
        environment=live_environment,
    )
    _run(
        [
            "uv",
            "run",
            "alembic",
            "-c",
            "db/alembic/alembic.ini",
            "current",
            "--check-heads",
        ],
        environment=live_environment,
    )
    _run(
        [
            "uv",
            "run",
            "pytest",
            "-p",
            "no:cacheprovider",
            "-m",
            "postgres",
            "db/tests/postgres",
        ],
        environment=live_environment,
    )


def seed(environment: dict[str, str]) -> None:
    _run(
        ["uv", "run", "python", "db/seeds/seed_development.py"],
        environment=_migration_environment(environment),
    )


def bootstrap() -> None:
    environment = _load_environment(create=True)
    _require_provider_safety(environment)
    _run(["uv", "sync", "--all-packages", "--locked"], environment=environment)
    _run(["pnpm", "install", "--frozen-lockfile"], environment=environment)
    _run(["pnpm", "auth:material"], environment=environment)
    environment = _load_environment()
    _run(_compose("up", "-d", "--wait", "postgres"), environment=environment)
    _bootstrap_roles(environment)
    migrate(environment)
    _run(["pnpm", "contracts:generate"], environment=environment)
    seed(environment)
    migration_check(environment)
    _run(["uv", "run", "python", "scripts/health_check.py"], environment=environment)
    print("Bootstrap complete. Run `make dev` for host hot reload.")


def voice_bootstrap() -> None:
    environment = _load_environment()
    _require_provider_safety(environment)
    _run(
        ["uv", "sync", "--all-packages", "--locked", "--group", "voice"],
        environment=environment,
    )
    print("Voice dependencies installed; all real provider flags remain disabled.")


def _ensure_local_voice_credentials() -> dict[str, str]:
    """Create ignored localhost-only LiveKit credentials when fields are blank."""

    if not ENV_FILE.exists():
        raise RuntimeError(".env is missing; run `make bootstrap` first")
    generated = {
        "LIVEKIT_API_KEY": f"local-{secrets.token_urlsafe(18)}",
        "LIVEKIT_API_SECRET": secrets.token_urlsafe(48),
    }
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    found: set[str] = set()
    updated: list[str] = []
    changed = False
    for line in lines:
        if "=" not in line or line.lstrip().startswith("#"):
            updated.append(line)
            continue
        key, value = line.split("=", maxsplit=1)
        normalized = key.strip()
        if normalized not in generated:
            updated.append(line)
            continue
        found.add(normalized)
        if value.strip().strip('"').strip("'"):
            updated.append(line)
            continue
        updated.append(f"{normalized}={generated[normalized]}")
        changed = True
    for key, value in generated.items():
        if key not in found:
            updated.append(f"{key}={value}")
            changed = True
    if changed:
        ENV_FILE.write_text("\n".join(updated) + "\n", encoding="utf-8")
        with suppress(OSError):
            ENV_FILE.chmod(0o600)
        print("Generated ignored localhost-only LiveKit credentials.")
    return _load_environment()


def _voice_profile_environment() -> dict[str, str]:
    environment = _load_environment()
    _require_provider_safety(environment)
    from scripts.verify_voice_profile import validate_local_credentials

    validate_local_credentials(
        environment.get("LIVEKIT_API_KEY", ""),
        environment.get("LIVEKIT_API_SECRET", ""),
    )
    return environment


def voice_check() -> None:
    environment = _voice_profile_environment()
    port = environment.get("LIVEKIT_PORT", "7880")
    _run(
        [
            "uv",
            "run",
            "--group",
            "voice",
            "python",
            "scripts/verify_voice_profile.py",
            "--url",
            f"http://127.0.0.1:{port}",
        ],
        environment=environment,
    )


def voice_up() -> None:
    voice_bootstrap()
    environment = _ensure_local_voice_credentials()
    _require_provider_safety(environment)
    from scripts.verify_voice_profile import validate_local_credentials

    validate_local_credentials(
        environment.get("LIVEKIT_API_KEY", ""),
        environment.get("LIVEKIT_API_SECRET", ""),
    )
    _run(
        _compose(
            "up",
            "-d",
            "--wait",
            "redis",
            "livekit",
            "livekit-sip",
            profile="voice",
        ),
        environment=environment,
    )
    voice_check()


def voice_down() -> None:
    environment = _load_environment()
    _run(
        _compose("stop", "livekit-sip", "livekit", "redis", profile="voice"),
        environment=environment,
    )


def dev() -> None:
    environment = _load_environment()
    # Real WhatsApp may be explicitly enabled for the guarded Phase 6 queue/UI.
    # Telephony and AI providers remain prohibited on this command surface.
    _require_non_whatsapp_provider_safety(environment)
    if not ENV_FILE.exists():
        raise RuntimeError(".env is missing; run `make bootstrap` first")
    _run(_compose("up", "-d", "--wait", "postgres"), environment=environment)
    migration_check(environment)
    commands = (["uv", "run", "or-on-control-api"], ["pnpm", "dev"])
    # Both commands are fixed platform entrypoints and are never shell-expanded.
    processes = [
        subprocess.Popen(_resolve_command(command), cwd=ROOT, env=environment)  # noqa: S603
        for command in commands
    ]
    print("Development processes started; press Ctrl+C to stop host processes.")
    interrupted = False
    try:
        while all(process.poll() is None for process in processes):
            for process in processes:
                try:
                    process.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    continue
    except KeyboardInterrupt:
        interrupted = True
        print("Stopping host development processes...")
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
    if not interrupted:
        failed = [process.returncode for process in processes if process.returncode != 0]
        if failed:
            raise RuntimeError(f"a development process exited unexpectedly: {failed}")


def lint() -> None:
    _run(["pnpm", "format:check"])
    _run(["pnpm", "lint"])
    _run(["uv", "run", "ruff", "format", "--check", *PYTHON_PATHS])
    _run(["uv", "run", "ruff", "check", *PYTHON_PATHS])
    _run(["uv", "run", "python", "scripts/check_repository.py"])
    _run(["uv", "run", "python", "scripts/check_secrets.py"])
    _run(["uv", "run", "python", "scripts/check_docs.py"])


def format_code() -> None:
    _run(["pnpm", "format"])
    _run(["uv", "run", "ruff", "format", *PYTHON_PATHS])


def typecheck() -> None:
    voice_bootstrap()
    _run(["pnpm", "typecheck"])
    _run(["uv", "run", "pyrefly", "check", *PYTHON_TYPE_PATHS])


def test() -> None:
    voice_bootstrap()
    _run(["pnpm", "test"])
    _run(["uv", "run", "pytest", "-p", "no:cacheprovider"])


def verify(environment: dict[str, str]) -> None:
    _require_provider_safety(environment)
    lint()
    typecheck()
    test()
    _run(["pnpm", "contracts:check"], environment=environment)
    migration_check(environment)
    _run(["pnpm", "build"], environment=environment)
    _run(["pnpm", "peers", "check"])
    _run(["pnpm", "audit", "--audit-level", "critical"])
    _run(["uv", "run", "pip-audit"])


def help_text() -> None:
    print(
        """Or-On Platform commands
  doctor           check required local tools and ports
  bootstrap        sync core dependencies, start PostgreSQL, migrate, seed, and health-check
  voice-bootstrap  install the opt-in heavy Pipecat/audio development group
  voice-up         start and read-only verify local Redis/LiveKit/SIP control plane
  voice-check      list SIP control-plane resources without mutating them
  voice-down       stop only the optional local voice infrastructure
  dev              run web, control API, live-agent, and messaging-worker on the host
  stop / ps / logs manage the local Compose stack without deleting its volume
  migrate / migration-check / seed
                   operate the sole Alembic lineage and fictional seed
  migration-graph / migration-sql / db-contract-check
                   inspect the canonical graph and deterministic PostgreSQL SQL offline
  db-verify-offline verify repository-controlled database artifacts without a server
  db-verify-live    execute the Phase 2B suite against isolated PostgreSQL 18.6
  lint / format / typecheck / test / verify
                   run target-repository quality gates

No command enables providers automatically. Real WhatsApp is accepted by `dev`
only when the ignored environment explicitly opts in; every send still requires
RBAC, consent, confirmation, durable admission, and the worker boundary switch.
"""
    )


def _compose_action(environment: dict[str, str], *arguments: str) -> None:
    _run(_compose(*arguments), environment=environment)


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "help"
    environment = _load_environment()
    actions: dict[str, Callable[[], None]] = {
        "help": help_text,
        "doctor": doctor,
        "bootstrap": bootstrap,
        "voice-bootstrap": voice_bootstrap,
        "voice-up": voice_up,
        "voice-check": voice_check,
        "voice-down": voice_down,
        "dev": dev,
        "stop": lambda: _compose_action(environment, "stop"),
        "ps": lambda: _compose_action(environment, "ps"),
        "logs": lambda: _compose_action(environment, "logs", "--follow", "--tail", "200"),
        "migrate": lambda: migrate(environment),
        "migration-check": lambda: migration_check(environment),
        "migration-graph": migration_graph,
        "migration-sql": migration_sql,
        "db-contract-check": db_contract_check,
        "db-verify-offline": lambda: db_verify_offline(environment),
        "db-verify-live": lambda: db_verify_live(environment),
        "seed": lambda: seed(environment),
        "lint": lint,
        "format": format_code,
        "typecheck": typecheck,
        "test": test,
        "verify": lambda: verify(environment),
    }
    action = actions.get(command)
    if action is None:
        raise RuntimeError(f"unknown command {command!r}; run `make help`")
    action()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1) from error
