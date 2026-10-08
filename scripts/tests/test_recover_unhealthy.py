import json
import sys
from types import SimpleNamespace

import pytest

from scripts import recover_unhealthy as recovery
from scripts.recover_unhealthy import eligible

UNHEALTHY = {"Status": "running", "Health": {"Status": "unhealthy"}}


def test_only_allowlisted_running_unhealthy_services_can_restart() -> None:
    assert eligible("messaging-worker", UNHEALTHY, [], 1000)
    assert eligible("caddy", UNHEALTHY, [], 1000)
    for service in ("postgres", "migrator", "dispatcher", "sweeper", "bootstrap-owner", "x;rm"):
        assert not eligible(service, UNHEALTHY, [], 1000)
    for state in (
        {},
        {"Status": "exited"},
        {"Status": "running"},
        {"Status": "running", "Health": {"Status": "healthy"}},
        {"Status": "running", "Health": {"Status": "starting"}},
    ):
        assert not eligible("web", state, [], 1000)


def test_restart_cooldown_and_window_budget_survive_persistent_failure() -> None:
    assert not eligible("web", UNHEALTHY, [800], 1000)
    assert eligible("web", UNHEALTHY, [700], 1000)
    assert not eligible("web", UNHEALTHY, [100, 600], 1000)
    assert eligible("web", UNHEALTHY, [99, 600], 1000)
    assert not eligible("web", UNHEALTHY, [1001], 1000)


@pytest.mark.parametrize("apply", [False, True])
def test_actual_cli_dry_run_or_one_nondependent_restart(tmp_path, monkeypatch, apply) -> None:
    (tmp_path / "shared").mkdir()
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(recovery, "ROOT", tmp_path)
    monkeypatch.setattr(recovery, "Path", lambda _: tmp_path / "lock")
    monkeypatch.setitem(
        sys.modules, "fcntl", SimpleNamespace(flock=lambda *_: None, LOCK_EX=1, LOCK_NB=2)
    )
    monkeypatch.setattr(sys, "argv", ["recovery", *(["--apply"] if apply else [])])
    monkeypatch.setattr(recovery.time, "time", lambda: 1000)
    calls = []

    def command(arguments):
        calls.append(arguments)
        if "ps" in arguments:
            return "a" * 64 if arguments[-1] == "caddy" else ""
        if arguments[0] == "inspect":
            return "running" if arguments[2] == "{{.State.Status}}" else "unhealthy"
        assert arguments[-5:] == ["restart", "--no-deps", "--timeout", "45", "caddy"]
        # Attempt is durable before any restart, including failure.
        assert json.loads((tmp_path / "shared/recovery-state.json").read_text()) == {
            "caddy": [1000]
        }
        return ""

    monkeypatch.setattr(recovery, "command", command)
    recovery.main()
    assert sum("restart" in call for call in calls) == int(apply)
    recovery.main()
    assert sum("restart" in call for call in calls) == int(apply)
    assert not any(("restart" in call and "postgres" in call) or "up" in call for call in calls)


def test_command_failures_cannot_print_private_stdout(monkeypatch) -> None:
    def failed(*_, **__):
        raise RuntimeError("private DSN must never be printed")

    monkeypatch.setattr(recovery.subprocess, "run", failed)
    with pytest.raises(RuntimeError):
        recovery.command(["inspect", "--format", "{{json .State}}", "a" * 64])


def test_dry_run_has_no_restart_or_persistence(monkeypatch, tmp_path) -> None:
    from scripts import recover_unhealthy as recovery

    calls = []
    monkeypatch.setattr(
        recovery,
        "inspect_state",
        lambda _, service: (
            {"Status": "running", "Health": {"Status": "healthy"}}
            if service == "postgres"
            else UNHEALTHY
        ),
    )
    monkeypatch.setattr(recovery, "command", lambda args: calls.append(args))
    path = tmp_path / "state.json"
    recovery.recover(["compose"], path, {}, 1000)
    assert calls == []
    assert not path.exists()


def test_db_outage_does_not_restart_dependent_services(monkeypatch, tmp_path) -> None:
    from scripts import recover_unhealthy as recovery

    calls = []
    monkeypatch.setattr(recovery, "inspect_state", lambda *_: UNHEALTHY)
    monkeypatch.setattr(recovery, "command", lambda args: calls.append(args))
    recovery.recover(["compose"], tmp_path / "state.json", {}, 1000, apply=True)
    assert calls == [["compose", "restart", "--no-deps", "--timeout", "45", "caddy"]]


def test_failed_restart_consumes_persistent_budget(monkeypatch, tmp_path) -> None:
    import json

    import pytest

    from scripts import recover_unhealthy as recovery

    monkeypatch.setattr(recovery, "inspect_state", lambda *_: UNHEALTHY)
    path = tmp_path / "state.json"

    def fail(args):
        assert json.loads(path.read_text(encoding="utf8")) == {"caddy": [1000]}
        raise RuntimeError("synthetic CLI failure")

    monkeypatch.setattr(recovery, "command", fail)
    with pytest.raises(RuntimeError):
        recovery.recover(["compose"], path, {}, 1000, apply=True)
    assert not recovery.eligible("caddy", UNHEALTHY, [1000], 1001)


def test_corruption_rejects_all_actions_before_inspect(monkeypatch, tmp_path) -> None:
    import pytest

    from scripts import recover_unhealthy as recovery

    def unexpected(*_):
        raise AssertionError("must validate before inspecting")

    monkeypatch.setattr(recovery, "inspect_state", unexpected)
    for state in (
        {"postgres": []},
        {"web": [True]},
        {"web": [-1]},
        {"web": [1001]},
        {"web": "bad"},
    ):
        with pytest.raises(ValueError, match="Invalid recovery state"):
            recovery.recover(["compose"], tmp_path / "state.json", state, 1000, apply=True)


def test_inspect_reads_status_only_not_health_logs(monkeypatch) -> None:
    from scripts import recover_unhealthy as recovery

    calls = []

    def cli(args):
        calls.append(args)
        return "a" * 64 if args[-2:] == ["--quiet", "web"] else "running"

    monkeypatch.setattr(recovery, "command", cli)
    recovery.inspect_state(["compose"], "web")
    assert len(calls) == 3
    assert all("json .State" not in " ".join(args) for args in calls)
    assert all(".Log" not in " ".join(args) for args in calls)


def test_worker_restart_preserves_ninety_second_drain(monkeypatch, tmp_path) -> None:
    calls = []

    def status(_, service):
        return (
            {"Status": "running", "Health": {"Status": "healthy"}}
            if service in ("postgres", "caddy", "web")
            else UNHEALTHY
        )

    monkeypatch.setattr(recovery, "inspect_state", status)
    monkeypatch.setattr(recovery, "schema_matches_release", lambda _: True)
    monkeypatch.setattr(recovery, "command", lambda args: calls.append(args))
    recovery.recover(["compose"], tmp_path / "state.json", {}, 1000, apply=True)
    assert calls == [["compose", "restart", "--no-deps", "--timeout", "90", "messaging-worker"]]


@pytest.mark.parametrize(
    "actual", ["f4ec0637b92e", "9b2e7a4c6d18", "", "f4ec0637b92e\nf3db9526a81d"]
)
def test_schema_probe_requires_exact_single_release_head(monkeypatch, tmp_path, actual) -> None:
    directory = tmp_path / "current/db/contracts"
    directory.mkdir(parents=True)
    (directory / "schema-manifest.json").write_text(json.dumps({"alembic_head": "f4ec0637b92e"}))
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(recovery, "ROOT", tmp_path)
    calls = []

    def run(args, **kwargs):
        calls.append(args)
        assert kwargs["timeout"] == 10
        assert "default_transaction_read_only=on" in args[-1]
        assert "statement_timeout=5000" in args[-1]
        return SimpleNamespace(stdout=actual)

    monkeypatch.setattr(recovery.subprocess, "run", run)
    assert recovery.schema_matches_release(["compose"]) == (actual == "f4ec0637b92e")
    assert len(calls) == 1


def test_schema_probe_missing_manifest_and_failed_probe_close(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(recovery, "ROOT", tmp_path)
    assert not recovery.schema_matches_release(["compose"])
    directory = tmp_path / "current/db/contracts"
    directory.mkdir(parents=True)
    (directory / "schema-manifest.json").write_text(json.dumps({"alembic_head": "f4ec0637b92e"}))
    monkeypatch.setattr(
        recovery.subprocess,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("private")),
    )
    assert not recovery.schema_matches_release(["compose"])


def test_schema_mismatch_suppresses_app_restart_with_healthy_database(
    monkeypatch, tmp_path
) -> None:
    calls = []
    monkeypatch.setattr(
        recovery,
        "inspect_state",
        lambda _, service: (
            {"Status": "running", "Health": {"Status": "healthy"}}
            if service == "postgres"
            else UNHEALTHY
        ),
    )
    monkeypatch.setattr(recovery, "schema_matches_release", lambda _: False)
    monkeypatch.setattr(recovery, "command", lambda args: calls.append(args))
    recovery.recover(["compose"], tmp_path / "state.json", {}, 1000, apply=True)
    assert calls == [["compose", "restart", "--no-deps", "--timeout", "45", "caddy"]]


def test_recovery_rejects_nonlinux_before_opening_a_deployment_lock(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(sys, "argv", ["recovery"])
    with pytest.raises(RuntimeError, match="Linux host"):
        recovery.main()
