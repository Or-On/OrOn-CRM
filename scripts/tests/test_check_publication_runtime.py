"""Publication acceptance must execute every named case on an owned fixture."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from scripts import check_publication_runtime as check

SOURCE = "postgresql://platform_migrator:fictional@127.0.0.1:55480/developer"
OWNED = "oron_crm_" + "a" * 32


def report():
    return {
        "success": True,
        "numTotalTests": len(check.SUITES),
        "numPassedTests": len(check.SUITES),
        "testResults": [
            {"name": f"src/{name}", "assertionResults": [{"status": "passed"}]}
            for name in check.SUITES
        ],
    }


def junit():
    return (
        "<testsuites><testsuite>"
        + "".join(f'<testcase name="{name}" />' for name in check.PYTHON_CASES)
        + "</testsuite></testsuites>"
    )


def test_migration_authority_and_owned_database_required():
    assert check.publication_url(SOURCE, OWNED).endswith("/" + OWNED)
    for source, name in [
        (SOURCE.replace("platform_migrator", "postgres"), OWNED),
        (SOURCE.replace("127.0.0.1", "example.com"), OWNED),
        (SOURCE.replace("55480", "5432"), OWNED),
        (SOURCE, "developer"),
        (SOURCE, "oron_crm_a"),
    ]:
        with pytest.raises(ValueError):
            check.publication_url(source, name)


@pytest.mark.parametrize(
    "fault", ["missing", "duplicate", "empty", "skipped", "pending", "failed", "totals"]
)
def test_vitest_rejects_incomplete_or_nonpassing_reports(fault):
    value = report()
    assert check.verify_vitest(value) == len(check.SUITES)
    if fault == "missing":
        value["testResults"].pop()
    elif fault == "duplicate":
        value["testResults"].append(value["testResults"][0])
    elif fault == "empty":
        value["testResults"][0]["assertionResults"] = []
    elif fault == "totals":
        value["numPassedTests"] = 0
    else:
        value["testResults"][0]["assertionResults"][0]["status"] = fault
    with pytest.raises(RuntimeError):
        check.verify_vitest(value)


@pytest.mark.parametrize("fault", ["missing", "skipped", "failure", "error"])
def test_pytest_requires_each_named_case_without_skips(tmp_path, fault):
    path = tmp_path / "junit.xml"
    path.write_text(junit(), encoding="utf-8")
    assert check.verify_pytest(path) == len(check.PYTHON_CASES)
    value = junit()
    value = (
        value.replace("<testcase", "<other", 1)
        if fault == "missing"
        else value.replace(" />", f"><{fault}/></testcase>", 1)
    )
    path.write_text(value, encoding="utf-8")
    with pytest.raises(RuntimeError):
        check.verify_pytest(path)


@pytest.mark.parametrize("failure", [None, "migration", "context", "tests"])
def test_owned_database_removed_on_success_and_each_failure(monkeypatch, failure):
    connection = AsyncMock()
    monkeypatch.setattr(check.asyncpg, "connect", AsyncMock(return_value=connection))
    monkeypatch.setenv("MIGRATION_DATABASE_URL", SOURCE)
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-reach-child")

    def run(command, environment):
        assert "OPENAI_API_KEY" not in environment
        assert environment["ENABLE_REAL_VOICE_PROVIDERS"] == "false"
        if "alembic" in command and failure == "migration":
            raise RuntimeError("migration fixture")
        if command[0] == "pnpm":
            if failure == "tests":
                raise RuntimeError("test fixture")
            output = next(
                part.split("=", 1)[1] for part in command if part.startswith("--outputFile=")
            )
            Path(output).write_text(json.dumps(report()), encoding="utf-8")
            if failure != "context":
                Path(environment["PUBLICATION_CONTEXT_PATH"]).write_text("{}", encoding="utf-8")
        if "pytest" in command:
            output = next(
                part.split("=", 1)[1] for part in command if part.startswith("--junitxml=")
            )
            Path(output).write_text(junit(), encoding="utf-8")
        return ""

    monkeypatch.setattr(check, "run", run)
    if failure:
        with pytest.raises(RuntimeError):
            asyncio.run(check.main())
    else:
        asyncio.run(check.main())
    statements = [call.args[0] for call in connection.execute.await_args_list]
    assert (
        len(statements) == 2
        and statements[0].startswith('CREATE DATABASE "oron_crm_')
        and statements[1].startswith('DROP DATABASE "oron_crm_')
    )
    connection.close.assert_awaited_once()
