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
            "mkdir -p /proof/previous",
            'compose_previous() { printf "%s\\n" "$*" > /proof/rollback; }',
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
