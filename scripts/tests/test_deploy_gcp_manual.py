"""Manual release admission fails closed before registry or machine writes."""

import argparse
import copy
import json
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest

from scripts import deploy_gcp_manual as deploy

SHA = "a" * 40


def successful_run():
    return {
        "head_sha": SHA,
        "head_branch": "main",
        "event": "push",
        "path": ".github/workflows/ci.yml",
        "status": "completed",
        "conclusion": "success",
        "repository": {"full_name": deploy.REPOSITORY},
        "html_url": "https://github.com/Or-On/OrOn-CRM/actions/runs/1",
    }


def successful_jobs():
    return [{"name": name, "conclusion": "success"} for name in deploy.JOBS]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("head_sha", "b" * 40),
        ("head_branch", "feature"),
        ("event", "pull_request"),
        ("path", "dynamic/dependabot/update-graph"),
        ("status", "in_progress"),
        ("conclusion", "failure"),
        ("repository", {"full_name": "untrusted/fork"}),
    ],
)
def test_unrelated_green_runs_are_not_deployment_authority(field, value):
    run = successful_run()
    run[field] = value
    with pytest.raises(ValueError):
        deploy.validate_ci(SHA, run, successful_jobs())


@pytest.mark.parametrize("defect", ["missing", "duplicate", "failed", "skipped"])
def test_every_named_gate_must_succeed(defect):
    jobs = successful_jobs()
    if defect == "missing":
        jobs.pop()
    elif defect == "duplicate":
        jobs.append(copy.deepcopy(jobs[0]))
    else:
        jobs[0]["conclusion"] = defect
    with pytest.raises(ValueError):
        deploy.validate_ci(SHA, successful_run(), jobs)


def test_valid_ci_and_current_main_are_checked(monkeypatch):
    responses = {
        "git/ref/heads/main": {"object": {"sha": SHA}},
        "actions/runs/1": successful_run(),
        "actions/runs/1/jobs?filter=latest&per_page=100": {
            "total_count": len(deploy.JOBS),
            "jobs": successful_jobs(),
        },
    }
    monkeypatch.setattr(deploy, "github", responses.__getitem__)
    assert deploy.check_ci(SHA, 1)["success"] is True
    responses["git/ref/heads/main"]["object"]["sha"] = "b" * 40
    with pytest.raises(ValueError, match="Main tip"):
        deploy.check_ci(SHA, 1)


def test_plan_does_not_execute_or_construct_cloud_client(monkeypatch):
    monkeypatch.setattr(
        deploy.sys,
        "argv",
        ["deploy", "--revision", SHA, "--expected-current", "b" * 40, "--ci-run-id", "1"],
    )
    monkeypatch.setattr(deploy, "command", lambda *_: SHA)
    monkeypatch.setattr(deploy, "check_ci", lambda *_: {"success": True})
    monkeypatch.setattr(deploy, "execute", lambda *_: pytest.fail("Plan must not deploy"))
    monkeypatch.setattr(deploy, "gcloud_binary", lambda: pytest.fail("Plan is read-only"))
    assert deploy.main() == 0


@pytest.mark.parametrize("value", ["HEAD", "a" * 39, "A" * 40, "a" * 40 + ";echo bad"])
def test_shell_metacharacters_and_symbolic_revisions_are_rejected(value):
    with pytest.raises(argparse.ArgumentTypeError):
        deploy.exact_sha(value)


def test_payload_is_the_actual_allowlisted_release(tmp_path):
    images = {name: f"{deploy.REGISTRY}/{name}@sha256:{'b' * 64}" for name in deploy.IMAGES}
    archive = deploy.assemble(deploy.ROOT, tmp_path, images)
    with tarfile.open(archive) as contents:
        assert {item.name for item in contents} == {*deploy.FILES, "images.env"}
        member = contents.extractfile("db/contracts/schema-manifest.json")
        assert member is not None
        assert json.load(member)["alembic_head"]
        for name in deploy.FILES:
            member = contents.extractfile(name)
            assert member is not None
            assert member.read() == (deploy.ROOT / name).read_bytes()


@pytest.mark.parametrize("actual", ["a" * 40, "b" * 40, "missing"])
def test_machine_compare_and_swap_runs_before_mutation(tmp_path: Path, actual: str):
    source = (deploy.ROOT / "scripts/deploy-dev.sh").read_text(encoding="utf-8")
    start = source.index("if [[ -n ${EXPECTED_CURRENT_COMMIT} ]]")
    end = source.index("available_bytes=", start)
    assert source.index("flock --nonblock 9") < start
    assert end < source.index("readonly RECOVERY_DIR=")
    if actual != "missing":
        (tmp_path / "deployed-commit").write_text(actual)
    docker = shutil.which("docker")
    if docker is None:
        pytest.skip("Docker required for isolated Bash guard proof")
    result = subprocess.run(  # noqa: S603
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
            f"set -Eeuo pipefail\nORON_ROOT=/proof\nEXPECTED_CURRENT_COMMIT={SHA}\n"
            + source[start:end]
            + "touch /proof/mutated\n",
        ],
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == (0 if actual == SHA else 1), result.stderr
    assert (tmp_path / "mutated").exists() == (actual == SHA)
