"""Run mandatory WhatsApp runtime acceptance on an owned, provider-free database."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import secrets
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import asyncpg

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts.dev import _resolve_command  # noqa: E402

SUITES = (
    "ai-principal.postgres.test.ts",
    "principal-handoff.postgres.test.ts",
    "machine-lead-tools.postgres.test.ts",
    "machine-service-tools.postgres.test.ts",
    "opening-menu-worker.postgres.test.ts",
    "opening-menu-activation.postgres.test.ts",
    "opening-menu-resume.postgres.test.ts",
)
DATABASE_VARIABLES = (
    "DATABASE_URL",
    "CRM_TEST_DATABASE_URL",
    "PRINCIPAL_TEST_DATABASE_URL",
    "MACHINE_TOOLS_TEST_DATABASE_URL",
    "OPENING_MENU_TEST_DATABASE_URL",
)


def isolated_url(source: str, database: str) -> str:
    parsed = urlsplit(source)
    if parsed.scheme != "postgresql" or parsed.hostname != "127.0.0.1" or parsed.port != 55480:
        raise ValueError("WhatsApp checks require explicit PostgreSQL at 127.0.0.1:55480")
    if not re.fullmatch(r"oron_crm_[a-f0-9]{32}", database):
        raise ValueError("WhatsApp checks may only create their own UUID database")
    return urlunsplit((parsed.scheme, parsed.netloc, f"/{database}", "", ""))


def child_environment(source: Mapping[str, str], target: str) -> dict[str, str]:
    environment = {
        key: value
        for key, value in source.items()
        if key.upper()
        in {
            "CI",
            "PATH",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "COMSPEC",
            "PATHEXT",
            "PROGRAMFILES",
            "HOMEDRIVE",
            "HOMEPATH",
        }
    }
    environment.update({key: target for key in DATABASE_VARIABLES})
    environment.update(
        {
            "ENABLE_REAL_WHATSAPP": "false",
            "ENABLE_REAL_SMS": "false",
            "ENABLE_REAL_TELEPHONY": "false",
            "ENABLE_REAL_VOICE_PROVIDERS": "false",
            "ENABLE_WHATSAPP_AI": "false",
            "ENABLE_WHATSAPP_AUTO_CALLS": "false",
            "FIELD_CIPHER_BACKEND": "local",
            "FIELD_CIPHER_LOCAL_KEY": base64.b64encode(secrets.token_bytes(32)).decode(),
            "BLIND_INDEX_KEY": base64.b64encode(secrets.token_bytes(32)).decode(),
            "AUTH_TOKEN_PEPPER": secrets.token_hex(32),
            "AUTH_SERVICE_SECRET": secrets.token_hex(32),
            "DEV_AUTH_EMAIL": "demo@example.invalid",
            "NEXT_TELEMETRY_DISABLED": "1",
            "PUBLIC_SITE_URL": "http://127.0.0.1:3100",
            "CONTROL_API_URL": "http://127.0.0.1:1",
            "PYTHONIOENCODING": "utf-8",
        }
    )
    return environment


def run(command: list[str], environment: dict[str, str], *, cwd: Path = ROOT) -> str:
    completed = subprocess.run(  # noqa: S603
        _resolve_command(command),
        cwd=cwd,
        env=environment,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=600,
    )
    if completed.returncode:
        diagnostic = completed.stdout + completed.stderr
        for key, value in environment.items():
            if value and any(
                part in key for part in ("URL", "KEY", "PASSWORD", "SECRET", "TOKEN", "PEPPER")
            ):
                diagnostic = diagnostic.replace(value, "[REDACTED]")
        print(diagnostic, file=sys.stderr)
        raise RuntimeError(f"WhatsApp acceptance command failed: {command[0]}")
    return completed.stdout.strip()


def verify_report(report: dict) -> int:
    """Fail closed if any named suite is absent, empty, skipped, pending or failed."""
    suites = report.get("testResults", [])
    observed: dict[str, list] = {}
    for suite in suites:
        name = str(suite.get("name", "")).replace("\\", "/").rsplit("/", 1)[-1]
        if name in observed:
            raise RuntimeError("Duplicate WhatsApp acceptance suite report")
        observed[name] = suite.get("assertionResults", [])
    if set(observed) != set(SUITES):
        raise RuntimeError("A mandatory WhatsApp acceptance suite did not run")
    for assertions in observed.values():
        if not assertions or any(test.get("status") != "passed" for test in assertions):
            raise RuntimeError("WhatsApp acceptance includes empty, skipped or failed tests")
    count = sum(len(assertions) for assertions in observed.values())
    if (
        report.get("success") is not True
        or report.get("numTotalTests") != count
        or report.get("numPassedTests") != count
        or any(report.get(key, 0) for key in ("numPendingTests", "numTodoTests", "numFailedTests"))
    ):
        raise RuntimeError("WhatsApp acceptance totals do not match mandatory passing tests")
    return count


async def main() -> None:
    # Never consult .env. CI or the caller must explicitly nominate a local
    # migration connection; child processes receive no inherited provider keys.
    source = os.environ.get("MIGRATION_DATABASE_URL", "")
    database = f"oron_crm_{uuid4().hex}"
    target = isolated_url(source, database)
    admin = await asyncpg.connect(
        urlunsplit(urlsplit(target)._replace(path="/postgres")), timeout=10
    )
    created = False
    try:
        await admin.execute(f'CREATE DATABASE "{database}"')
        created = True
        environment = child_environment(os.environ, target)
        environment["CHECK_PASSWORD"] = secrets.token_urlsafe(32)
        password_hash = await asyncio.to_thread(
            run,
            [
                "node",
                "--input-type=module",
                "-e",
                "import { hash } from '@node-rs/argon2'; "
                "console.log(await hash(process.env.CHECK_PASSWORD, "
                "{algorithm:2,memoryCost:65536,timeCost:3,parallelism:1,outputLen:32}));",
            ],
            environment,
            cwd=ROOT / "packages/ts/auth",
        )
        environment.pop("CHECK_PASSWORD")
        environment["DEV_AUTH_PASSWORD_HASH"] = password_hash
        environment["AUTH_DUMMY_PASSWORD_HASH"] = password_hash
        print("Migrating and seeding owned WhatsApp acceptance database", flush=True)
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
        await asyncio.to_thread(
            run,
            ["uv", "run", "--no-sync", "python", "db/seeds/seed_development.py"],
            environment,
        )
        with TemporaryDirectory(prefix="oron-whatsapp-runtime-") as directory:
            report = Path(directory) / "vitest.json"
            print(f"Running {len(SUITES)} mandatory WhatsApp runtime suites", flush=True)
            await asyncio.to_thread(
                run,
                [
                    "pnpm",
                    "--filter",
                    "@or-on/messaging-worker",
                    "exec",
                    "vitest",
                    "run",
                    *(f"tests/{suite}" for suite in SUITES),
                    "--reporter=default",
                    "--reporter=json",
                    f"--outputFile={report}",
                ],
                environment,
            )
            count = verify_report(
                json.loads(await asyncio.to_thread(report.read_text, encoding="utf-8"))
            )
            print(
                f"WhatsApp runtime acceptance: {count} passed, {len(SUITES)} suites, zero skips",
                flush=True,
            )
    finally:
        try:
            if created:
                # Revalidate the exact generated name before every destructive operation.
                isolated_url(source, database)
                await admin.execute(f'DROP DATABASE "{database}" WITH (FORCE)')
                print("Owned WhatsApp acceptance database removed", flush=True)
        finally:
            await admin.close()


if __name__ == "__main__":
    asyncio.run(main())
