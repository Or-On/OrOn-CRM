"""Mandatory runtime coverage must fail closed and never use a developer database."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from scripts import check_whatsapp_runtime as check

SOURCE = "postgresql://fixture:secret@127.0.0.1:55480/developer?application_name=old"
OWNED = "oron_crm_" + "a" * 32


def report() -> dict:
    return {
        "success": True,
        "numTotalTests": len(check.SUITES),
        "numPassedTests": len(check.SUITES),
        "numPendingTests": 0,
        "numTodoTests": 0,
        "numFailedTests": 0,
        "testResults": [
            {"name": f"C:/fixture/tests/{suite}", "assertionResults": [{"status": "passed"}]}
            for suite in check.SUITES
        ],
    }


def test_owned_destination_discards_existing_database_and_connection_options() -> None:
    assert check.isolated_url(SOURCE, OWNED) == (
        f"postgresql://fixture:secret@127.0.0.1:55480/{OWNED}"
    )


@pytest.mark.parametrize(
    ("source", "database"),
    [
        ("", OWNED),
        ("postgresql://fixture@example.com:55480/postgres", OWNED),
        ("postgresql://fixture@127.0.0.1:5432/postgres", OWNED),
        ("postgresql://fixture@127.0.0.1:55480/postgres", "developer"),
        (SOURCE, 'oron_crm_"; DROP DATABASE developer;'),
        (SOURCE, "oron_crm_"),
    ],
)
def test_refuses_remote_or_unowned_destinations(source: str, database: str) -> None:
    with pytest.raises(ValueError):
        check.isolated_url(source, database)


def test_child_environment_removes_provider_and_unrelated_database_credentials() -> None:
    target = check.isolated_url(SOURCE, OWNED)
    environment = check.child_environment(
        {
            "PATH": "fixture-bin",
            "CI": "true",
            "OPENAI_API_KEY": "real-model-key",
            "WHATSAPP_ACCESS_TOKEN": "real-provider-token",
            "DATABASE_URL": "postgresql://production.invalid/private",
            "MIGRATION_DATABASE_URL": SOURCE,
            "ENABLE_REAL_WHATSAPP": "true",
            "NODE_OPTIONS": "--require=injected-code",
        },
        target,
    )
    assert "OPENAI_API_KEY" not in environment
    assert "WHATSAPP_ACCESS_TOKEN" not in environment
    assert "MIGRATION_DATABASE_URL" not in environment
    assert "NODE_OPTIONS" not in environment
    assert environment["ENABLE_REAL_WHATSAPP"] == "false"
    assert environment["PATH"] == "fixture-bin"
    assert all(environment[key] == target for key in check.DATABASE_VARIABLES)


def test_report_requires_all_explicit_suites_to_run_successfully() -> None:
    assert check.verify_report(report()) == len(check.SUITES)


@pytest.mark.parametrize("fault", ["absent", "empty", "skipped", "pending", "failed", "totals"])
def test_report_rejects_missing_skipped_and_inconsistent_results(fault: str) -> None:
    value = report()
    if fault == "absent":
        value["testResults"].pop()
    elif fault == "empty":
        value["testResults"][0]["assertionResults"] = []
    elif fault == "totals":
        value["numPassedTests"] = 0
    else:
        value["testResults"][0]["assertionResults"][0]["status"] = fault
    with pytest.raises(RuntimeError):
        check.verify_report(value)


@pytest.mark.parametrize("failure", [None, "migration", "tests", "skipped"])
def test_database_cleanup_runs_after_success_and_child_failures(
    monkeypatch: pytest.MonkeyPatch,
    failure: str | None,
) -> None:
    connection = AsyncMock()
    connect = AsyncMock(return_value=connection)
    monkeypatch.setenv("MIGRATION_DATABASE_URL", SOURCE)
    monkeypatch.setattr(check.asyncpg, "connect", connect)
    commands: list[list[str]] = []

    def run(command: list[str], environment: dict[str, str], **_kwargs) -> str:
        commands.append(command)
        assert environment["DATABASE_URL"].startswith(
            "postgresql://fixture:secret@127.0.0.1:55480/oron_crm_"
        )
        if command[0] == "node":
            return "fictional-hash"
        if failure == "migration" and "alembic" in command:
            raise RuntimeError("fixture migration failed")
        if command[0] == "pnpm":
            if failure == "tests":
                raise RuntimeError("fixture test command failed")
            output = next(
                arg.split("=", 1)[1] for arg in command if arg.startswith("--outputFile=")
            )
            value = report()
            if failure == "skipped":
                value["testResults"][0]["assertionResults"][0]["status"] = "pending"
            Path(output).write_text(json.dumps(value), encoding="utf-8")
        return ""

    monkeypatch.setattr(check, "run", run)
    if failure is None:
        asyncio.run(check.main())
    else:
        with pytest.raises(RuntimeError):
            asyncio.run(check.main())
    maintenance = connect.call_args.args[0]
    assert maintenance == "postgresql://fixture:secret@127.0.0.1:55480/postgres"
    executed = [call.args[0] for call in connection.execute.await_args_list]
    assert len(executed) == 2
    created = executed[0].removeprefix('CREATE DATABASE "').removesuffix('"')
    assert check.isolated_url(SOURCE, created)
    assert executed[1] == f'DROP DATABASE "{created}" WITH (FORCE)'
    connection.close.assert_awaited_once()
    if failure != "migration":
        assert all(f"tests/{suite}" in commands[-1] for suite in check.SUITES)


def test_missing_explicit_migration_url_never_connects(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MIGRATION_DATABASE_URL", raising=False)
    connect = AsyncMock()
    monkeypatch.setattr(check.asyncpg, "connect", connect)
    with pytest.raises(ValueError):
        asyncio.run(check.main())
    connect.assert_not_called()
