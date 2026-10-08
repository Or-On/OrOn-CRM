"""Mandatory Task 6 publication/admission acceptance; no servers or provider traffic."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import asyncpg
from defusedxml import ElementTree

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts.check_whatsapp_runtime import child_environment, isolated_url, run  # noqa: E402

SUITES = (
    "publication-bindings.postgres.test.ts",
    "agent-reset.postgres.test.ts",
    "effective-prompt.postgres.test.ts",
    "agent-quality-gate.postgres.test.ts",
)
PYTHON_FILES = (
    "services/py/control-api/tests/test_voice_source_postgres.py",
    "services/py/dispatcher/tests/test_instruction_provenance_postgres.py",
)
PYTHON_CASES = {
    "test_exact_source_tenant_denial_server_allocation_and_identical_retry",
    "test_real_admission_uses_exact_triggers_in_warm_and_second_instances",
    "test_admitted_hash_is_immutable_and_every_fallback_attempt_is_attributed",
}


def publication_url(source: str, database: str) -> str:
    if urlsplit(source).username != "platform_migrator":
        raise ValueError("Publication checks require the designated migration authority")
    return isolated_url(source, database)


def verify_vitest(report: dict) -> int:
    observed = {}
    for suite in report.get("testResults", []):
        name = str(suite.get("name", "")).replace("\\", "/").rsplit("/", 1)[-1]
        if name in observed:
            raise RuntimeError("Duplicate publication suite report")
        observed[name] = suite.get("assertionResults", [])
    if set(observed) != set(SUITES):
        raise RuntimeError("Mandatory publication suite missing")
    if any(
        not cases or any(case.get("status") != "passed" for case in cases)
        for cases in observed.values()
    ):
        raise RuntimeError("Publication suite includes empty, skipped or failed tests")
    count = sum(map(len, observed.values()))
    if (
        report.get("success") is not True
        or report.get("numTotalTests") != count
        or report.get("numPassedTests") != count
        or any(report.get(key, 0) for key in ("numPendingTests", "numTodoTests", "numFailedTests"))
    ):
        raise RuntimeError("Publication test totals mismatch")
    return count


def verify_pytest(path: Path) -> int:
    root = ElementTree.parse(path).getroot()
    if root is None:
        raise RuntimeError("Python publication report is empty")
    cases = root.findall(".//testcase")
    if (
        len(cases) != len(PYTHON_CASES)
        or {case.attrib.get("name") for case in cases} != PYTHON_CASES
    ):
        raise RuntimeError("Mandatory Python publication cases missing or duplicated")
    if any(
        any(case.find(tag) is not None for tag in ("skipped", "failure", "error")) for case in cases
    ):
        raise RuntimeError("Python publication cases did not all pass")
    return len(cases)


async def main() -> None:
    source = os.environ.get("MIGRATION_DATABASE_URL", "")
    database = f"oron_crm_{uuid4().hex}"
    target = publication_url(source, database)
    admin = await asyncpg.connect(
        urlunsplit(urlsplit(target)._replace(path="/postgres")), timeout=10
    )
    created = False
    try:
        await admin.execute(f'CREATE DATABASE "{database}"')
        created = True
        environment = child_environment(os.environ, target)
        environment["AGENT_QUALITY_GATE_TEST_DATABASE_URL"] = target
        environment["PUBLICATION_TEST_DATABASE_URL"] = target
        print("Migrating owned publication acceptance database", flush=True)
        await asyncio.to_thread(
            run,
            [
                "uv",
                "run",
                "--no-sync",
                "alembic",
                "-c",
                "db/alembic/alembic.ini",
                "upgrade",
                "head",
            ],
            environment,
        )
        with TemporaryDirectory(prefix="oron-publication-runtime-") as directory:
            context = Path(directory) / "context.json"
            vitest = Path(directory) / "vitest.json"
            junit = Path(directory) / "pytest.xml"
            environment["PUBLICATION_CONTEXT_PATH"] = str(context)
            await asyncio.to_thread(
                run,
                [
                    "pnpm",
                    "--filter",
                    "@or-on/crm",
                    "exec",
                    "vitest",
                    "run",
                    *(f"src/{suite}" for suite in SUITES),
                    "--reporter=default",
                    "--reporter=json",
                    f"--outputFile={vitest}",
                ],
                environment,
            )
            ts_count = verify_vitest(json.loads(vitest.read_text(encoding="utf-8")))
            if not context.is_file():
                raise RuntimeError("Committed admission fixture context was not produced")
            await asyncio.to_thread(
                run,
                [
                    "uv",
                    "run",
                    "--no-sync",
                    "pytest",
                    "-p",
                    "no:cacheprovider",
                    *PYTHON_FILES,
                    "-q",
                    f"--junitxml={junit}",
                ],
                environment,
            )
            py_count = verify_pytest(junit)
            print(
                f"Publication runtime acceptance: {ts_count} TypeScript + "
                f"{py_count} Python passed; zero skips",
                flush=True,
            )
    finally:
        try:
            if created:
                publication_url(source, database)
                await admin.execute(f'DROP DATABASE "{database}" WITH (FORCE)')
                print("Owned publication acceptance database removed", flush=True)
        finally:
            await admin.close()


if __name__ == "__main__":
    asyncio.run(main())
