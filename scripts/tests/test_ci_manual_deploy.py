"""Prevent source publication from causing an unintended infrastructure write."""

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
MANUAL_MAIN = (
    "github.ref == 'refs/heads/main' && "
    "github.event_name == 'workflow_dispatch' && inputs.deploy_dev == true"
)


def _workflow() -> dict:
    workflow = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8"))
    # PyYAML's YAML1.1 parser interprets the unquoted key `on` as true.
    # Preserve safe loading while restoring GitHub's trigger key.
    if "on" not in workflow:
        workflow["on"] = workflow.pop(True)
    return workflow


def _condition(value: str) -> str:
    return " ".join(value.split())


def test_database_acceptance_uses_owned_fixture_port_without_changing_readiness() -> None:
    job = _workflow()["jobs"]["database"]
    assert "55480:5432" in job["services"]["postgres"]["ports"]
    for name in ("DATABASE_URL", "TEST_DATABASE_URL"):
        assert "@127.0.0.1:55480/" in job["env"][name]
    assert "@127.0.0.1:55439/" in job["env"]["READINESS_POSTGRES_URL"]
    for step in job["steps"]:
        for name, value in step.get("env", {}).items():
            if name in ("CRM_TEST_DATABASE_URL", "CROSS_CHANNEL_TEST_DATABASE_URL"):
                assert "@127.0.0.1:55480/" in value


def test_main_push_keeps_ci_and_manual_deployment_defaults_off() -> None:
    workflow = _workflow()
    assert "main" in workflow["on"]["push"]["branches"]
    assert "pull_request" in workflow["on"]
    deploy = workflow["on"]["workflow_dispatch"]["inputs"]["deploy_dev"]
    assert deploy["type"] == "boolean"
    assert deploy["default"] is False
    assert deploy["required"] is False


def test_every_cloud_auth_publish_or_ssh_step_requires_manual_deploy() -> None:
    workflow = _workflow()
    dangerous_steps = 0
    for job in workflow["jobs"].values():
        for step in job.get("steps", []):
            run = step.get("run", "")
            cloud_action = step.get("uses", "").startswith("google-github-actions/")
            infrastructure_write = any(
                marker in run
                for marker in (
                    "docker push ",
                    "gcloud auth configure-docker",
                    "gcloud compute ssh",
                    "gcloud compute scp",
                    "gcloud compute os-login ssh-keys",
                    "ssh-keygen ",
                )
            )
            if not cloud_action and not infrastructure_write:
                continue
            dangerous_steps += 1
            assert MANUAL_MAIN in (
                _condition(job.get("if", "")),
                _condition(step.get("if", "")),
            ), step.get("name")
    assert dangerous_steps >= 7


def test_manual_deploy_still_requires_all_checks_and_environment() -> None:
    workflow = _workflow()
    deploy = workflow["jobs"]["deploy-dev"]
    assert _condition(deploy["if"]) == MANUAL_MAIN
    expected = {
        "typescript",
        "python",
        "database",
        "contracts",
        "architecture-security",
        "containers",
    }
    assert set(deploy["needs"]) == expected
    assert deploy["environment"]["name"] == "development"
    for name in expected:
        assert "if" not in workflow["jobs"][name]
