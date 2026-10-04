"""Run the actual rollback/trap fragment with synthetic commands, never Docker."""

from __future__ import annotations

import re
import shlex
import shutil
import subprocess
import tarfile
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "scripts" / "deploy-dev.sh"
BASH = (
    str(Path("C:/Program Files/Git/bin/bash.exe"))
    if Path("C:/Program Files/Git/bin/bash.exe").is_file()
    else shutil.which("bash")
)


def _fragment() -> str:
    source = DEPLOY.read_text(encoding="utf-8")
    start = source.index("native_caddy_was_active=false")
    end = source.index("# shellcheck disable=SC1091", start)
    return source[start:end]


def _run(
    ending: str,
    *,
    rollback_status: int = 0,
    schema_head: str = "a14d0c8e2b77",
    schema_status: int = 0,
) -> subprocess.CompletedProcess[str]:
    if BASH is None:
        pytest.skip("Bash is required to exercise deployment control flow")
    harness = (
        """set -Eeuo pipefail
COMMIT_SHA=synthetic
SHARED_DIR=synthetic
CURRENT_LINK=synthetic
DEPLOYMENT_DATABASE_NAME=synthetic
previous_release=.
docker() {
  if [[ "$*" == *alembic_version* ]]; then
    printf 'SCHEMA_HEAD\\n'; return SCHEMA_STATUS
  fi
  printf 'RESTORE %s\\n' "$*"; return ROLLBACK_STATUS
}
timeout() { printf 'DEADLINE %s %s\\n' "$1" "$2" >&2; shift 2; "$@"; }
ln() { printf 'LINK %s\\n' "$*"; }
mv() { printf 'PUBLISH %s\\n' "$*"; }
systemctl() { printf 'NATIVE %s\\n' "$*"; }
""".replace("ROLLBACK_STATUS", str(rollback_status))
        .replace("SCHEMA_HEAD", schema_head)
        .replace("SCHEMA_STATUS", str(schema_status))
    )
    return subprocess.run(  # noqa: S603 - fixed Bash and repository-owned synthetic harness
        [BASH, "--noprofile", "--norc", "-s"],
        input=harness + _fragment() + "\n" + ending,
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )


@pytest.mark.parametrize("ending", ["exit 1", "false", "exit 0"])
def test_incomplete_exit_restores_previous_application_once(ending: str) -> None:
    started = time.monotonic()
    result = _run(ending)
    elapsed = time.monotonic() - started
    assert result.returncode == 1, result.stderr
    assert result.stdout.count("RESTORE ") == 1
    assert "--wait-timeout 90" in result.stdout
    assert "DEADLINE --kill-after=5s 105s" in result.stderr
    assert "PUBLISH -Tf synthetic.rollback synthetic" in result.stdout
    assert elapsed < 2, "synthetic recovery must not block on a real command"


def test_failed_rollback_preserves_original_error_and_reports_unproven_readiness() -> None:
    result = _run("exit 17", rollback_status=124)
    assert result.returncode == 17
    assert "did not prove readiness (status 124)" in result.stderr
    assert result.stdout.count("RESTORE ") == 1
    assert "PUBLISH " in result.stdout


def test_successful_deployment_does_not_restore_on_exit() -> None:
    result = _run("deployment_succeeded=true\nexit 0")
    assert result.returncode == 0, result.stderr
    assert "RESTORE " not in result.stdout


def test_pre_migration_recovery_restores_the_previously_running_sweeper() -> None:
    result = _run("previous_optional_services=(messaging-worker dispatcher sweeper)\nexit 1")
    assert result.returncode == 1, result.stderr
    assert "postgres control-api web caddy messaging-worker dispatcher sweeper" in result.stdout


def test_maintenance_stops_every_schema_writer_before_backup() -> None:
    if BASH is None:
        pytest.skip("Bash is required to exercise deployment maintenance")
    source = DEPLOY.read_text(encoding="utf-8")
    start = source.index(
        "if [[ -n ${previous_release} ]]; then", source.index("compose up --detach postgres")
    )
    end = source.index("if [[ -n ${previous_release} ]]; then", start + 1)
    harness = """set -Eeuo pipefail
previous_release=synthetic
RELEASE_DIR=synthetic
DEPLOYMENT_DATABASE_NAME=synthetic
declare -A running=([messaging-worker]=1 [web]=1 [caddy]=1
  [dispatcher]=1 [control-api]=1 [sweeper]=1)
compose_previous() {
  if [[ "$1" == stop ]]; then
    allocated_grace=$3
    shift 3
    for service in "$@"; do
      if [[ $service == dispatcher && $allocated_grace -lt 120 ]]; then
        echo dispatcher_cleanup_grace_shortened >&2; return 97
      fi
      running[$service]=0
    done
  elif [[ "$*" == *oron-sessions-sweeper* ]]; then
    echo ONE_SHOT_REPAIR
  elif [[ "$1" == exec ]]; then
    echo 0
  else
    echo unexpected_command >&2; return 99
  fi
}
synthetic/scripts/backup-dev.sh() {
  for service in messaging-worker web caddy dispatcher control-api sweeper; do
    [[ ${running[$service]} == 0 ]] || { echo "writer_live:$service" >&2; return 98; }
  done
  echo BACKUP_WITH_ALL_WRITERS_STOPPED
}
"""
    result = subprocess.run(  # noqa: S603 - actual repository fragment, synthetic commands
        [BASH, "--noprofile", "--norc", "-s"],
        input=harness + source[start:end],
        text=True,
        capture_output=True,
        timeout=5,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "ONE_SHOT_REPAIR" in result.stdout
    assert "BACKUP_WITH_ALL_WRITERS_STOPPED" in result.stdout


def test_stale_repair_precedes_active_session_wait_and_database_only_backup() -> None:
    source = DEPLOY.read_text(encoding="utf-8")
    assert source.index("sweeper oron-sessions-sweeper") < source.index("active_calls=0")
    assert '"${RELEASE_DIR}/scripts/backup-dev.sh" --database-only' in source
    assert "STALE_SESSION_MINUTES=120" in source
    unit = (ROOT / "infra/deployment/systemd/oron-dev.service").read_text(encoding="utf-8")
    assert "TimeoutStopSec=240" in unit
    # Full command ceiling is 105s plus a 5s forced termination allowance,
    # rather than an unbounded operation with a healthcheck-only timeout.
    assert re.search(r"timeout --kill-after=5s 105s docker compose", source)


def test_deploy_and_backup_parse_without_executing_any_commands() -> None:
    if BASH is None:
        pytest.skip("Bash is required for syntax validation")
    for script in (DEPLOY, ROOT / "scripts/backup-dev.sh"):
        result = subprocess.run(  # noqa: S603 - syntax-only parse of repository scripts
            [BASH, "-n"],
            input=script.read_text(encoding="utf-8"),
            text=True,
            capture_output=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("database_only", [True, False])
def test_backup_archive_mode_keeps_verified_database_and_optional_objects(
    tmp_path: Path,
    database_only: bool,
) -> None:
    if BASH is None:
        pytest.skip("Bash is required to exercise archive creation")
    staging = tmp_path / "staging"
    staging.mkdir()
    objects = tmp_path / "objects"
    objects.mkdir()
    (objects / "synthetic.txt").write_text("fictional", encoding="utf-8")
    for name in (
        "database.dump",
        "release.txt",
        "schema-head.txt",
        "security-contract.json",
        "release.tar",
        "backup-manifest.json",
    ):
        (staging / name).write_text("synthetic", encoding="utf-8")
    archive = tmp_path / "synthetic.tar.gz"
    source = (ROOT / "scripts/backup-dev.sh").read_text(encoding="utf-8")
    fragment = source[source.index("backup_members=(") : source.index("gzip --test")]

    def shell_path(path: Path) -> str:
        value = path.as_posix()
        if path.drive:
            value = f"/{value[0].lower()}{value[2:]}"
        return value

    assignments = {
        "database_only": str(database_only).lower(),
        "temporary_dir": shell_path(staging),
        "objects_dir": shell_path(objects),
        "temporary_archive": shell_path(archive),
    }
    harness = "set -Eeuo pipefail\nexport PATH=/usr/bin:$PATH\n" + "\n".join(
        f"{key}={shlex.quote(value)}" for key, value in assignments.items()
    )
    result = subprocess.run(  # noqa: S603 - quoted synthetic paths and repository fragment
        [BASH, "--noprofile", "--norc", "-s"],
        input=harness + "\n" + fragment,
        text=True,
        capture_output=True,
        timeout=5,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    with tarfile.open(archive) as bundle:
        assert set(bundle.getnames()) == {
            "database.dump",
            "release.txt",
            "schema-head.txt",
            "security-contract.json",
            "release.tar",
            "backup-manifest.json",
            "SHA256SUMS",
        } | (set() if database_only else {"objects.tar"})
        checksum_file = bundle.extractfile("SHA256SUMS")
        assert checksum_file is not None
        checksums = checksum_file.read().decode()
        assert "database.dump" in checksums
        assert ("objects.tar" in checksums) is not database_only


@pytest.mark.parametrize("head,status", [("b672f9a6c310", 0), ("", 124), ("", 0)])
def test_schema_advance_or_unreadable_schema_refuses_legacy_rollback(head, status):
    result = _run(
        "schema_migration_started=true\nschema_head_before_migration=a14d0c8e2b77\nexit 19",
        schema_head=head,
        schema_status=status,
    )
    assert result.returncode == 19
    assert "rollback refused" in result.stderr
    assert "RESTORE " not in result.stdout
    assert "PUBLISH " not in result.stdout
    assert "DEADLINE --kill-after=1s 5s" in result.stderr


def test_transactionally_unchanged_schema_allows_prior_application_recovery():
    result = _run(
        "schema_migration_started=true\nschema_head_before_migration=a14d0c8e2b77\nexit 7"
    )
    assert result.returncode == 7
    assert result.stdout.count("RESTORE ") == 1
    assert "PUBLISH " in result.stdout


def test_stop_and_backup_order_prevents_old_worker_overlap_with_revoke_migration():
    source = DEPLOY.read_text(encoding="utf8")
    stop = source.index("stop --timeout 120 messaging-worker web caddy")
    drained = source.index("stop --timeout 120 dispatcher control-api sweeper")
    backup = source.index('"${RELEASE_DIR}/scripts/backup-dev.sh" --database-only')
    capture = source.index('schema_head_before_migration="$(compose exec')
    marker = source.index("schema_migration_started=true")
    migrate = source.index("compose --profile release run --rm migrator")
    assert stop < drained < backup < capture < marker < migrate


def test_unchanged_head_guard_requires_transactional_migration_lineage():
    environment = (ROOT / "db/alembic/env.py").read_text(encoding="utf8")
    assert "with context.begin_transaction():" in environment
    assert "transactional_ddl=False" not in environment.replace(" ", "")
    for migration in (ROOT / "db/alembic/versions").glob("*.py"):
        source = migration.read_text(encoding="utf8")
        assert "autocommit_block" not in source, migration.name
        assert not re.search(r"\bCOMMIT\s*;", source, re.IGNORECASE), migration.name
        assert not re.search(r"CREATE\s+INDEX\s+CONCURRENTLY", source, re.IGNORECASE), (
            migration.name
        )
    deploy = DEPLOY.read_text(encoding="utf8")
    assert "alembic downgrade" not in deploy
    assert "pg_restore" not in deploy
