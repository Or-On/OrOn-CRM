"""Execute the deployment EXIT handler against controlled local shell failures."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("failure", ["exit 1", "false", "exit 143"])
def test_explicit_exit_and_command_failure_restore_previous_release(failure: str, tmp_path: Path):
    source = (ROOT / "scripts/deploy-dev.sh").read_text(encoding="utf-8")
    handler = source.split("native_caddy_was_active=false", 1)[1].split(
        "# shellcheck disable=SC1091", 1
    )[0]
    script = "\n".join(
        [
            "set -Eeuo pipefail",
            "COMMIT_SHA=fictional; previous_release=/proof/previous; CURRENT_LINK=/proof/current",
            "SHARED_DIR=/proof; DEPLOYMENT_DATABASE_NAME=fictional",
            "mkdir -p /proof/previous",
            "restore_private_configuration() { :; }",
            'docker() { printf "%s\\n" "$*" > /proof/rollback; }',
            'timeout() { shift 2; "$@"; }',
            "native_caddy_was_active=false" + handler,
            failure,
        ]
    )
    docker = shutil.which("docker")
    if docker is None:
        pytest.skip("Docker required for portable Bash failure drill")
    # No secrets, network, application containers or user volumes are available.
    completed = subprocess.run(  # noqa: S603
        [
            docker,
            "run",
            "--rm",
            "--network",
            "none",
            "--mount",
            f"type=bind,source={tmp_path},target=/proof",
            "--entrypoint",
            "bash",
            "postgres:18.6-bookworm",
            "-c",
            script,
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert completed.returncode == (143 if failure == "exit 143" else 1), completed.stderr
    assert "up --detach" in (tmp_path / "rollback").read_text()
    assert "attempting application rollback" in completed.stderr
    if os.name != "nt":
        assert (tmp_path / "current").is_symlink()


def test_voice_wait_does_not_stop_messaging_and_manual_gate_is_explicit():
    deploy = (ROOT / "scripts/deploy-dev.sh").read_text(encoding="utf-8")
    before_wait = deploy.split("active_calls=0", 1)[0]
    assert "stop --timeout 120 messaging-worker web caddy" not in before_wait
    workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    gate = workflow.split("  deploy-dev:", 1)[1].split("    needs:", 1)[0]
    assert "github.event_name == 'workflow_dispatch' && inputs.deploy_dev" in gate
    assert "github.event_name == 'push'" not in gate


@pytest.mark.parametrize("failure", ["exit 1", "false", "exit 143"])
@pytest.mark.parametrize("existing_sweeper", [False, True])
def test_failed_preflight_restores_actual_private_files_before_application_trap(
    failure: str, existing_sweeper: bool, tmp_path: Path
):
    """Execute the real early EXIT guard and real cp/rm on owned fixture files."""
    source = (ROOT / "scripts/deploy-dev.sh").read_text(encoding="utf-8")
    start = source.index("restore_private_configuration()")
    end = source.index("for file in \\\n", start)
    assert end < source.index("set_private_config_value \"${DISPATCHER_CONFIG}\" TTS_FIRST_CLAUSE")
    snapshot = tmp_path / "snapshot"
    (snapshot / "config").mkdir(parents=True)
    (snapshot / "config/dispatcher.env").write_text("TTS_FIRST_CLAUSE=true\n")
    (snapshot / "deployment.env").write_text("FIXTURE=original\n")
    if existing_sweeper:
        (snapshot / "config/sweeper.env").write_text("FIXTURE=existing-sweeper\n")
        (snapshot / "deployed-commit").write_text("old-reviewed-revision\n")
    (tmp_path / "deployed-commit").write_text("incomplete-new-revision\n")
    current = tmp_path / "shared"
    (current / "config").mkdir(parents=True)
    (current / "config/dispatcher.env").write_text("TTS_FIRST_CLAUSE=false\n")
    (current / "config/sweeper.env").write_text("FIXTURE=derived-sweeper\n")
    (current / "deployment.env").write_text("FIXTURE=changed\n")
    docker = shutil.which("docker")
    if docker is None:
        pytest.skip("Docker required for portable Bash preflight failure drill")
    script = (
        "set -Eeuo pipefail\nORON_ROOT=/proof\nRECOVERY_DIR=/proof/snapshot\n"
        "SHARED_DIR=/proof/shared\nSWEEPER_CONFIG=/proof/shared/config/sweeper.env\n"
        + source[start:end]
        + failure
        + "\n"
    )
    completed = subprocess.run(  # noqa: S603 - networkless owned synthetic fixture
        [
            docker,
            "run",
            "--rm",
            "--network",
            "none",
            "--mount",
            f"type=bind,source={tmp_path},target=/proof",
            "--entrypoint",
            "bash",
            "postgres:18.6-bookworm",
            "-c",
            script,
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert completed.returncode == (143 if failure == "exit 143" else 1), completed.stderr
    assert (current / "config/dispatcher.env").read_text() == "TTS_FIRST_CLAUSE=true\n"
    assert (current / "deployment.env").read_text() == "FIXTURE=original\n"
    if existing_sweeper:
        assert (current / "config/sweeper.env").read_text() == "FIXTURE=existing-sweeper\n"
        assert (tmp_path / "deployed-commit").read_text() == "old-reviewed-revision\n"
    else:
        assert not (current / "config/sweeper.env").exists()
        assert not (tmp_path / "deployed-commit").exists()
