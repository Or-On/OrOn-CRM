"""Exercise reviewed deployment admission and cleanup with synthetic inputs."""

import importlib.util
import os
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
BASH = "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else "bash"


def workflow():
    return yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())


@pytest.mark.parametrize(
    "expected,actual,success",
    [
        ("a" * 40, "a" * 40, True),
        ("b" * 40, "a" * 40, False),
        ("", "a" * 40, False),
        ("$(echo unsafe)", "a" * 40, False),
    ],
)
def test_exact_commit_guard_before_cloud_auth(expected, actual, success):
    for name in ("containers", "deploy-dev"):
        steps = workflow()["jobs"][name]["steps"]
        index = next(
            i
            for i, step in enumerate(steps)
            if step.get("name") == "Verify exact approved deployment commit"
        )
        assert index < next(
            i
            for i, step in enumerate(steps)
            if step.get("uses", "").startswith("google-github-actions/auth@")
        )
        result = subprocess.run(  # noqa: S603 - repository shell fragments and synthetic inputs only
            [BASH, "-s"],
            input=steps[index]["run"],
            text=True,
            capture_output=True,
            env={**os.environ, "EXPECTED_COMMIT": expected, "GITHUB_SHA": actual},
            timeout=5,
        )
        assert (result.returncode == 0) is success


@pytest.mark.parametrize(
    "users,available,db,success",
    [
        ("1", "3000000000", "1000", True),
        ("0", "3000000000", "1000", False),
        ("bad", "3000000000", "1000", False),
        ("1", "1000", "1000", False),
    ],
)
def test_pre_stop_identity_and_disk_gate(users, available, db, success):
    source = (ROOT / "scripts/deploy-dev.sh").read_text()
    start = source.index("# Refuse bootstrap and reserve")
    end = source.index("if [[ -n ${previous_release} ]]; then", start)
    harness = f"""set -Eeuo pipefail
ORON_ROOT=synthetic
DEPLOYMENT_DATABASE_NAME=synthetic
compose() {{ if [[ "$*" == *count* ]]; then echo {users}; else echo {db}; fi; }}
df() {{ echo {available}; }}
tail() {{ while read -r line; do echo "$line"; done; }}
tr() {{ while read -r line; do echo "$line"; done; }}
"""
    result = subprocess.run(  # noqa: S603 - repository shell fragments and synthetic inputs only
        [BASH, "-s"], input=harness + source[start:end], text=True, capture_output=True, timeout=5
    )
    assert (result.returncode == 0) is success
    assert start < source.index("compose_previous stop --timeout 120 messaging-worker")


def test_cleanup_checks_exact_key_not_comment_or_fingerprint_format():
    spec = importlib.util.spec_from_file_location(
        "cleanup", ROOT / "scripts/check-oslogin-cleanup.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.verify("ssh-rsa synthetic-a comment", [{"key": "ssh-rsa synthetic-b comment"}])
    module.verify("ssh-rsa synthetic-a comment", [])
    with pytest.raises(ValueError, match="remains registered"):
        module.verify(
            "ssh-rsa synthetic-a comment", [{"key": "ssh-rsa synthetic-a changed-comment"}]
        )
    with pytest.raises(ValueError):
        module.verify("ssh-rsa synthetic-a", {"unexpected": "shape"})


def test_retention_bootstrap_and_timer_mutations_are_absent():
    deploy = (ROOT / "scripts/deploy-dev.sh").read_text()
    backup = (ROOT / "scripts/backup-dev.sh").read_text()
    for forbidden in (
        "docker image prune",
        "tail -n +6",
        "run --rm bootstrap-owner",
        "systemctl disable",
        "systemctl enable",
        "systemctl start oron-dev-backup.timer",
        "systemctl daemon-reload",
    ):
        assert forbidden not in deploy
    assert "-delete" not in backup
    assert deploy.index('cp -a "${SHARED_DIR}/config"') < deploy.index("set_private_config_value")


def test_cleanup_supports_actual_gcloud_additional_properties_shape():
    spec = importlib.util.spec_from_file_location(
        "cleanup_actual", ROOT / "scripts/check-oslogin-cleanup.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.verify(
        "ssh-rsa synthetic-a", [{"key": "fingerprint-b", "value": {"key": "ssh-rsa synthetic-b"}}]
    )
    with pytest.raises(ValueError, match="remains registered"):
        module.verify(
            "ssh-rsa synthetic-a",
            [{"key": "fingerprint-a", "value": {"key": "ssh-rsa synthetic-a comment"}}],
        )
    with pytest.raises(ValueError):
        module.verify("ssh-rsa synthetic-a", [{"key": "fingerprint"}])


def test_units_require_exact_reviewed_bytes_before_admission_stop():
    source = (ROOT / "scripts/deploy-dev.sh").read_text()
    assert 'cmp -s "${RELEASE_DIR}/infra/deployment/systemd/${unit}"' in source
    assert source.index("cmp -s") < source.index(
        "compose_previous stop --timeout 120 messaging-worker"
    )


@pytest.mark.parametrize(
    "revision,head,success",
    [
        ("a" * 40, "fc6e851f3ba0", True),
        ("b" * 40, "fc6e851f3ba0", False),
        ("a" * 40, "9b2e7a4c6d18", False),
    ],
)
def test_runtime_receipt_rejects_wrong_revision_or_schema(revision, head, success):
    source = (ROOT / "scripts/verify-dev-runtime.sh").read_text()
    fragment = source[source.index("for pair in ") :]
    harness = f"""set -Eeuo pipefail
expected_commit={"a" * 40}
DEPLOYMENT_DATABASE_NAME=synthetic
WEB_IMAGE=synthetic
CONTROL_API_IMAGE=synthetic
MESSAGING_WORKER_IMAGE=synthetic
DISPATCHER_IMAGE=synthetic
MIGRATOR_IMAGE=synthetic
compose=(fake_compose)
fake_compose() {{
  if [[ "$*" == *alembic_version* ]]; then echo {head}; else echo synthetic-container; fi
}}
docker() {{
  case "$*" in
    *State.Status*) echo running ;;
    *State.Health*) echo healthy ;;
    *opencontainers.image.revision*) echo {revision} ;;
    *) echo sha256:synthetic ;;
  esac
}}
"""
    result = subprocess.run(  # noqa: S603 - reviewed receipt fragment, synthetic commands only
        [BASH, "-s"], input=harness + fragment, text=True, capture_output=True, timeout=5
    )
    assert (result.returncode == 0) is success
