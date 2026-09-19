from __future__ import annotations

import io
import re
import stat
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "scripts" / "deploy-dev.sh"
EXPECTED = {
    "images.env",
    "infra/caddy/Caddyfile.deployment",
    "infra/compose/deployment.yaml",
    "infra/deployment/systemd/oron-dev-backup.service",
    "infra/deployment/systemd/oron-dev-backup.timer",
    "infra/deployment/systemd/oron-dev.service",
    "scripts/backup-dev.sh",
    "scripts/deploy-dev.sh",
}


def _validator() -> str:
    source = DEPLOY.read_text(encoding="utf-8")
    match = re.search(
        r"python3 - \"\$\{RELEASE_ARCHIVE\}\" \"\$\{STAGING_DIR\}\" <<'PY'\n(.*?)\nPY",
        source,
        re.DOTALL,
    )
    assert match is not None
    return match.group(1)


def _member(name: str, *, kind: bytes = tarfile.REGTYPE, link: str = "") -> tarfile.TarInfo:
    item = tarfile.TarInfo(name)
    item.type = kind
    item.linkname = link
    item.mode = 0o644
    item.size = 1 if kind == tarfile.REGTYPE else 0
    return item


def _archive(path: Path, mutation: str | None = None) -> None:
    names = sorted(EXPECTED)
    if mutation == "missing":
        names.pop()
    with tarfile.open(path, "w:gz") as archive:
        root = tarfile.TarInfo(".")
        root.type = tarfile.DIRTYPE
        root.mode = 0o755
        archive.addfile(root)
        for name in names:
            if mutation in {"symlink", "hardlink"} and name == names[0]:
                kind = tarfile.SYMTYPE if mutation == "symlink" else tarfile.LNKTYPE
                archive.addfile(_member(name, kind=kind, link=names[-1]))
            else:
                archive.addfile(_member(name), io.BytesIO(b"x"))
        if mutation == "duplicate":
            archive.addfile(_member(names[0]), io.BytesIO(b"x"))
        if mutation == "extra":
            archive.addfile(_member("unexpected.txt"), io.BytesIO(b"x"))
        if mutation == "traversal":
            archive.addfile(_member("../escape"), io.BytesIO(b"x"))


def _run_validator(archive: Path, destination: Path) -> subprocess.CompletedProcess[str]:
    destination.mkdir()
    return subprocess.run(  # noqa: S603 - fixed interpreter and local synthetic paths
        [sys.executable, "-", str(archive), str(destination)],
        input=_validator(),
        text=True,
        capture_output=True,
        check=False,
    )


def test_release_validator_extracts_only_the_exact_regular_payload(tmp_path: Path) -> None:
    archive = tmp_path / "release.tar.gz"
    destination = tmp_path / "release"
    _archive(archive)

    result = _run_validator(archive, destination)

    assert result.returncode == 0, result.stderr
    assert {
        str(item.relative_to(destination)).replace("\\", "/")
        for item in destination.rglob("*")
        if item.is_file()
    } == EXPECTED
    if sys.platform != "win32":
        caddyfile = destination / "infra" / "caddy" / "Caddyfile.deployment"
        assert stat.S_IMODE(caddyfile.stat().st_mode) == 0o644


@pytest.mark.parametrize(
    "mutation",
    ["missing", "extra", "duplicate", "traversal", "symlink", "hardlink"],
)
def test_release_validator_rejects_unsafe_or_incomplete_archives(
    tmp_path: Path, mutation: str
) -> None:
    archive = tmp_path / f"{mutation}.tar.gz"
    destination = tmp_path / mutation
    _archive(archive, mutation)

    result = _run_validator(archive, destination)

    assert result.returncode != 0


def test_ci_preserves_deploy_exit_status_and_binds_archive_checksum() -> None:
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert "deployer_sha256=$(sha256sum scripts/deploy-dev.sh" in workflow
    assert 'scripts/deploy-dev.sh "${DEV_VM}:${remote_deployer}"' in workflow
    assert "sha256sum '${remote_deployer}'" in workflow
    assert (
        "sudo bash '${remote_deployer}' '${GITHUB_SHA}' "
        "'${remote_archive}' '${ARCHIVE_SHA256}'" in workflow
    )
    assert "trap 'rm -f ${remote_archive} ${remote_deployer}' EXIT" in workflow
    assert "/opt/oron-dev/scripts/deploy-dev.sh" not in workflow
    assert "deploy-dev.sh '${GITHUB_SHA}' '${remote_archive}'; rm -f" not in workflow


def test_ci_uses_one_ephemeral_os_login_key_for_the_complete_dev_deploy() -> None:
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    assert "id-token: write" in workflow
    assert "google-github-actions/auth@" in workflow
    assert "workload_identity_provider:" in workflow
    assert "service_account:" in workflow
    assert "credentials_json" not in workflow
    assert "SSH_PRIVATE_KEY" not in workflow
    assert "${{ secrets." not in workflow

    assert 'key="${RUNNER_TEMP}/oron-dev-deploy"' in workflow
    assert "ssh-keygen -t rsa -b 3072" in workflow
    assert "gcloud compute os-login ssh-keys add" in workflow
    assert '--key-file="${key}.pub" --ttl=30m' in workflow
    assert 'echo "ORON_DEPLOY_SSH_KEY=${key}" >>"${GITHUB_ENV}"' in workflow

    transfer_commands = []
    lines = workflow.splitlines()
    for index, line in enumerate(lines):
        if "gcloud compute ssh " not in line and "gcloud compute scp " not in line:
            continue
        command = line.strip()
        while command.endswith("\\"):
            index += 1
            command = f"{command} {lines[index].strip()}"
        transfer_commands.append(command)

    assert len(transfer_commands) == 3
    for command in transfer_commands:
        assert '--ssh-key-file="${ORON_DEPLOY_SSH_KEY}"' in command
        assert "--tunnel-through-iap" in command
        assert '--project="${GCP_PROJECT_ID}"' in command
        assert '--zone="${GCP_ZONE}"' in command


def test_ci_bounds_dev_ssh_readiness_and_scp_retries() -> None:
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    assert "for attempt in $(seq 1 12); do" in workflow
    assert 'echo "SSH readiness attempt ${attempt}/12"' in workflow
    assert '--command="true"' in workflow
    assert "DEV SSH authentication never became ready" in workflow

    assert "for attempt in $(seq 1 5); do" in workflow
    assert 'echo "SCP attempt ${attempt}/5: ${source}"' in workflow
    assert "SCP failed after 5 attempts" in workflow
    assert workflow.count("transfer_with_retry ") == 2


def test_ci_cleans_up_ephemeral_key_and_keeps_portable_dev_entry_points() -> None:
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    cleanup = workflow[workflow.index("- name: Remove ephemeral DEV SSH key") :]

    assert "if: always()" in cleanup
    assert "continue-on-error: true" in cleanup
    assert "gcloud compute os-login ssh-keys remove" in cleanup
    assert '--key-file="${key}.pub"' in cleanup
    assert 'rm -f "${key}" "${key}.pub"' in cleanup

    assert "workflow_dispatch:" in workflow
    assert "github.event_name == 'workflow_dispatch'" in workflow
    assert "group: deploy-gcp-dev" in workflow
    assert "cancel-in-progress: false" in workflow
    assert "scripts/deploy-dev.sh" in workflow
    assert "Verify the public DEV endpoint" in workflow
    assert "https://dev.or-on.io/login" in workflow


def test_release_images_carry_and_enforce_source_revision() -> None:
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    deploy = DEPLOY.read_text(encoding="utf-8")
    assert workflow.count('--build-arg ORON_SOURCE_REVISION="$GITHUB_SHA"') == 5
    assert "org.opencontainers.image.revision" in deploy
    pull = 'docker pull "${release_images[${key}]}"'
    expected_keys = (
        "for key in WEB_IMAGE CONTROL_API_IMAGE MESSAGING_WORKER_IMAGE "
        "DISPATCHER_IMAGE MIGRATOR_IMAGE"
    )
    assert expected_keys in deploy
    assert pull in deploy
    assert deploy.index(pull) < deploy.index('revision="$(docker image inspect')
    for dockerfile in (
        ROOT / "apps" / "web" / "Dockerfile",
        ROOT / "services" / "py" / "control-api" / "Dockerfile",
        *(ROOT / "infra" / "images").glob("*.Dockerfile"),
    ):
        assert "org.opencontainers.image.revision" in dockerfile.read_text(encoding="utf-8")


def test_deploy_reclaims_obsolete_tagged_images_before_pulling_release() -> None:
    deploy = DEPLOY.read_text(encoding="utf-8")
    pull = 'docker pull "${release_images[${key}]}"'
    prune = "docker image prune --all --force"

    assert deploy.count(prune) == 2
    assert deploy.index(prune) < deploy.index(pull)
    assert "docker system prune" not in deploy
    assert "referenced by a running or stopped" in deploy


def test_control_api_image_contains_the_opt_in_voice_evaluation_runtime() -> None:
    dockerfile = (ROOT / "services" / "py" / "control-api" / "Dockerfile").read_text(
        encoding="utf-8"
    )

    assert "COPY packages/py/oron-agent packages/py/oron-agent" in dockerfile
    assert "COPY packages/py/oron-hebrew packages/py/oron-hebrew" in dockerfile
    assert "--package or-on-control-api --extra voice" in dockerfile
    assert "libpcre2-8-0=10.42-1+deb12u1 libsndfile1" in dockerfile
    assert "uv pip uninstall nltk" in dockerfile
    assert 'python -c "import control_api.app; import oron_agent.agent_evaluation"' in dockerfile


def test_deploy_probes_local_edge_without_requiring_public_ip_hairpin() -> None:
    deploy = DEPLOY.read_text(encoding="utf-8")
    assert "PLATFORM_ORIGIN must be an HTTPS origin" in deploy
    assert '--resolve "${PLATFORM_HOST}:443:127.0.0.1"' in deploy
    assert '--resolve "${PLATFORM_HOST}:80:127.0.0.1"' in deploy
    assert "compose logs --no-color --tail 100 caddy" in deploy
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert "https://dev.or-on.io/login" in workflow


def test_backup_covers_database_private_objects_and_checksums() -> None:
    backup = (ROOT / "scripts" / "backup-dev.sh").read_text(encoding="utf-8")
    assert "database.dump" in backup
    assert "objects.tar" in backup
    assert "SHA256SUMS" in backup
    assert "*.backup.tar.gz.sha256" in backup


def test_private_objects_are_shared_only_with_the_services_that_process_them() -> None:
    compose = (ROOT / "infra" / "compose" / "deployment.yaml").read_text(encoding="utf-8")
    deploy = DEPLOY.read_text(encoding="utf-8")

    object_mount = "${DEPLOYMENT_DATA_DIR}/objects:/var/lib/oron/objects"
    for service in ("dispatcher", "messaging-worker", "web"):
        block = re.search(
            rf"^  {re.escape(service)}:\n(?P<body>.*?)(?=^  [a-z][a-z0-9-]*:\n|\Z)",
            compose,
            re.MULTILINE | re.DOTALL,
        )
        assert block is not None
        assert object_mount in block.group("body")

    assert 'PRIVATE_OBJECTS_DIR="${SHARED_DIR}/data/objects"' in deploy
    assert 'install -d -m 0770 -o 100 -g 1000 "${PRIVATE_OBJECTS_DIR}"' in deploy
    assert "USER node" in (ROOT / "apps" / "web" / "Dockerfile").read_text(encoding="utf-8")
    assert "USER node" in (ROOT / "infra" / "images" / "messaging-worker.Dockerfile").read_text(
        encoding="utf-8"
    )


def test_deploy_rejects_inconsistent_field_service_private_storage_configuration() -> None:
    deploy = DEPLOY.read_text(encoding="utf-8")

    assert "read_private_config_value" in deploy
    assert "FIELD_CIPHER_LOCAL_KEY must match across field-service runtimes" in deploy
    assert "BLIND_INDEX_KEY must match across field-service runtimes" in deploy
    assert "FIELD_CIPHER_LOCAL_KEY must decode to exactly 32 bytes" in deploy
    assert "BLIND_INDEX_KEY must decode to at least 32 bytes" in deploy
    assert "ARTIFACTS_BACKEND must be local" in deploy
    assert "ARTIFACTS_LOCAL_ROOT is invalid" in deploy
    assert "Private runtime configuration must be owned by root" in deploy
    assert deploy.index("read_private_config_value") < deploy.index('exec 9>"${LOCK_FILE}"')


def test_messaging_worker_health_is_a_release_gate() -> None:
    compose = (ROOT / "infra" / "compose" / "deployment.yaml").read_text(encoding="utf-8")
    deploy = DEPLOY.read_text(encoding="utf-8")
    harness = (ROOT / "infra" / "scripts" / "readiness_stack.py").read_text(encoding="utf-8")

    worker = re.search(
        r"^  messaging-worker:\n(?P<body>.*?)(?=^  [a-z][a-z0-9-]*:\n|\Z)",
        compose,
        re.MULTILINE | re.DOTALL,
    )
    assert worker is not None
    assert '["CMD", "node", "dist/healthcheck.js"]' in worker.group("body")
    assert "messaging_worker_health" in deploy
    assert "fresh polling loop and database readiness" in deploy
    assert '"messaging-worker", "node", "dist/healthcheck.js"' in harness
    assert harness.count('"ARTIFACTS_LOCAL_ROOT=/var/lib/oron/objects"') == 3
    assert "chown 100:1000 /var/lib/oron/objects" in harness
    assert 'checks["shared_private_objects"] = "worker-to-web"' in harness


def test_edge_limit_allows_the_largest_content_validated_upload() -> None:
    caddy = (ROOT / "infra" / "caddy" / "Caddyfile.deployment").read_text(encoding="utf-8")
    assert "max_size 22MB" in caddy


def test_stale_session_sweeper_is_scheduled_and_least_privileged() -> None:
    """The dispatcher's owed-finalization backstop must actually run in DEV.

    Scheduling is a plain compose service in the already-enabled workers
    profile: one container, one bounded pass per interval, so sweeps never
    overlap and a failed pass only delays the next. The sweep must reach the
    database only as the voice runtime role, through the one definer function
    it is granted — never the migration role or a historical Or-on login.
    """

    compose = (ROOT / "infra" / "compose" / "deployment.yaml").read_text(encoding="utf-8")
    deploy = DEPLOY.read_text(encoding="utf-8")
    template = (ROOT / "infra" / "deployment" / "config" / "sweeper.env.template").read_text(
        encoding="utf-8"
    )
    migrate = (ROOT / "infra" / "scripts" / "migrate.py").read_text(encoding="utf-8")

    sweeper = re.search(
        r"^  sweeper:\n(?P<body>.*?)(?=^  [a-z][a-z0-9-]*:\n|\Z)",
        compose,
        re.MULTILINE | re.DOTALL,
    )
    assert sweeper is not None
    body = sweeper.group("body")
    assert "profiles: [workers]" in body  # starts with the existing DEV stack
    assert "oron-sessions-sweeper" in body  # the retained entry point, per interval
    assert "networks: [database]" in body  # database only: no egress, no edge
    assert "egress" not in body

    # The voice runtime login the dispatcher already holds; never a newly
    # activated historical Or-on role (the tenancy one still holds DML on
    # users, memberships and api_keys) and never a second provisioned password.
    assert "postgresql://platform_voice:" in template
    assert "CONTROL_DATABASE_URL" not in template
    assert "STALE_SESSION_MINUTES=" in template
    for legacy in ("oron_sessions_app", "oron_tenancy_app"):
        assert legacy not in template
        assert legacy not in migrate
        assert legacy not in deploy

    # Existing DEV hosts predate the sweeper config. Deployment bootstraps that
    # derived file from the dispatcher's voice DSN, then cannot silently carry
    # any other credential.
    assert '"${SHARED_DIR}/config/sweeper.env"' in deploy
    assert "if [[ ! -f ${SWEEPER_CONFIG} ]]; then" in deploy
    assert "DATABASE_URL=%s\\nSTALE_SESSION_MINUTES=120\\nSWEEP_INTERVAL_SECONDS=3600" in deploy
    assert 'install -m 0600 -o root -g root /dev/null "${SWEEPER_CONFIG}"' in deploy
    assert "sweeper.env DATABASE_URL must log in as platform_voice" in deploy
    assert "sweeper.env DATABASE_URL must equal dispatcher.env VOICE_DATABASE_URL" in deploy


def test_ci_lints_the_same_python_paths_as_make_lint() -> None:
    """`make lint` names `infra` in its ruff paths; CI must not silently lint a
    smaller set, or a gate that passes locally can still be bypassed remotely."""

    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert "uv run ruff format --check packages/py services/py db infra scripts" in workflow
    assert "uv run ruff check packages/py services/py db infra scripts" in workflow


def test_every_private_config_the_deployment_reads_is_proven_root_owned() -> None:
    """Reading a secret out of a file the script never checks the ownership of
    lets a non-root writer of that file choose a credential the deployment then
    provisions and uses. The ownership loop must therefore cover every config
    file `read_private_config_value` is called against, not just the ones whose
    checks were written first.
    """

    deploy = DEPLOY.read_text(encoding="utf-8")
    ownership_loop = re.search(
        r"for config_file in (?P<files>.*?); do\n\s*\[\[ \$\(stat --format='%u'",
        deploy,
        re.DOTALL,
    )
    assert ownership_loop is not None, "the root-ownership loop moved or was removed"
    proven = set(re.findall(r"\$\{([A-Z_]+_CONFIG)\}", ownership_loop.group("files")))
    read = set(re.findall(r'read_private_config_value "\$\{([A-Z_]+_CONFIG)\}"', deploy))

    assert read, "no private configuration reads found; the helper was renamed"
    assert read <= proven, f"read without an ownership check: {sorted(read - proven)}"


def test_the_sweeper_entry_point_ships_inside_the_migrator_image() -> None:
    """The sweeper service runs `oron-sessions-sweeper` out of the migrator
    image. Nothing in compose can prove that binary exists, so the closure that
    puts it there is pinned here: narrow the Dockerfile's sync, drop the
    control-api dependency, or rename the script, and the scheduled backstop
    becomes an hourly "command not found" that never exits non-zero.
    """

    dockerfile = (ROOT / "infra" / "images" / "migrator.Dockerfile").read_text(encoding="utf-8")
    control_api = (ROOT / "services" / "py" / "control-api" / "pyproject.toml").read_text(
        encoding="utf-8"
    )
    sessions = (ROOT / "packages" / "py" / "oron-sessions" / "pyproject.toml").read_text(
        encoding="utf-8"
    )
    compose = (ROOT / "infra" / "compose" / "deployment.yaml").read_text(encoding="utf-8")

    assert "uv sync --frozen --package or-on-control-api" in dockerfile
    assert "ENV PATH=/app/.venv/bin:$PATH" in dockerfile
    assert re.search(r'^\s*"oron-sessions==', control_api, re.MULTILINE)
    assert 'oron-sessions-sweeper = "oron_sessions.sweeper:main"' in sessions
    # Both services must resolve to the same immutable digest variable, or the
    # sweeper can run a different build from the migration that provisioned it.
    assert compose.count("${MIGRATOR_IMAGE:?Set an immutable migrator image digest}") == 2


def test_the_sweeper_cannot_fail_live_calls_underneath_the_session_budget() -> None:
    """`fail_stale_voice_sessions` flips any session still `started` past the cutoff,
    so the stale threshold has to sit above the longest call the agent permits.
    """

    template = (ROOT / "infra" / "deployment" / "config" / "sweeper.env.template").read_text(
        encoding="utf-8"
    )
    bot = (ROOT / "packages" / "py" / "oron-agent" / "src" / "oron_agent" / "bot.py").read_text(
        encoding="utf-8"
    )

    configured = re.search(r"^STALE_SESSION_MINUTES=(\d+)$", template, re.MULTILINE)
    assert configured is not None
    stale_seconds = int(configured.group(1)) * 60

    # The agent clamps its own session budget, and that ceiling is the longest a
    # session row can legitimately sit at `started`.
    clamp = re.search(r"min\((\d+), max_session_seconds\)", bot)
    assert clamp is not None, "the agent's session-budget clamp moved"
    assert stale_seconds > int(clamp.group(1))
