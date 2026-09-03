"""Isolated fictional UI preview. Never starts a worker or seeds the developer DB."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import socket
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit
from uuid import uuid4

import asyncpg

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.dev import _load_environment, _resolve_command  # noqa: E402


def isolated_url(source: str, database: str) -> str:
    parsed = urlsplit(source)
    if parsed.scheme != "postgresql" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("UI preview requires an explicit localhost PostgreSQL URL")
    if (
        not database.startswith("oron_ui_preview_")
        or not database.removeprefix("oron_ui_preview_").isalnum()
    ):
        raise ValueError("UI preview may only use its owned database prefix")
    return urlunsplit((parsed.scheme, parsed.netloc, f"/{database}", "", ""))


def run(command: list[str], environment: dict[str, str], *, cwd: Path = ROOT) -> str:
    completed = subprocess.run(  # noqa: S603
        _resolve_command(command),
        cwd=cwd,
        env=environment,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
    )
    if completed.returncode:
        if command == ["pnpm", "--filter", "@or-on/crm", "test"]:
            diagnostic = completed.stdout + completed.stderr
            for key, value in environment.items():
                if any(word in key for word in ("URL", "PASSWORD", "SECRET", "PEPPER")) and value:
                    diagnostic = diagnostic.replace(value, "[REDACTED]")
            print(diagnostic, file=sys.stderr)
        # Child output may include connection parameters; do not echo it.
        raise RuntimeError(f"Preview setup command failed: {command[0]}")
    return completed.stdout.strip()


async def main(*, check_db: bool = False, production: bool = False) -> None:
    if production and not (ROOT / "apps/web/.next/BUILD_ID").is_file():
        raise ValueError("Production preview requires pnpm build first")
    if not check_db:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 3100))
    source = _load_environment().get("MIGRATION_DATABASE_URL", "")
    database = f"oron_ui_preview_{uuid4().hex}"
    target = isolated_url(source, database)
    maintenance_url = urlunsplit(urlsplit(target)._replace(path="/postgres"))
    admin = await asyncpg.connect(maintenance_url, timeout=10)
    login_role = f"oron_ui_{uuid4().hex}"
    role_password = secrets.token_hex(24)
    password = secrets.token_urlsafe(24)
    artifact = ROOT / ".artifacts" / "phase7-preview-login.json"
    child: subprocess.Popen[str] | None = None
    created = False
    role_created = False
    try:
        await admin.execute(f'CREATE DATABASE "{database}"')
        created = True
        environment = {
            key: value
            for key, value in os.environ.items()
            if key.upper()
            in {
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
        environment.update(
            {
                "DATABASE_URL": target,
                "ENABLE_REAL_WHATSAPP": "false",
                "ENABLE_REAL_TELEPHONY": "false",
                "ENABLE_REAL_VOICE_PROVIDERS": "false",
                "AUTH_COOKIE_SECURE": "false",
                "PLATFORM_ENV": "development",
                "AUTH_TOKEN_PEPPER": secrets.token_hex(32),
                "AUTH_SERVICE_SECRET": secrets.token_hex(32),
                "DEV_AUTH_EMAIL": "demo@example.invalid",
                "PREVIEW_PASSWORD": password,
                "NEXT_TELEMETRY_DISABLED": "1",
                "PUBLIC_SITE_URL": "http://127.0.0.1:3100",
                # No connection to an independently running developer control API.
                # Port 1 is deliberately unavailable; voice/health show unavailable.
                "CONTROL_API_URL": "http://127.0.0.1:1",
            }
        )
        password_hash = run(
            [
                "node",
                "--input-type=module",
                "-e",
                "import { hash } from '@node-rs/argon2'; "
                "console.log(await hash(process.env.PREVIEW_PASSWORD, "
                "{algorithm:2,memoryCost:65536,timeCost:3,parallelism:1,outputLen:32}));",
            ],
            environment,
            cwd=ROOT / "packages/ts/auth",
        )
        environment.pop("PREVIEW_PASSWORD")
        environment["DEV_AUTH_PASSWORD_HASH"] = password_hash
        environment["AUTH_DUMMY_PASSWORD_HASH"] = password_hash
        run(
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
        run(["uv", "run", "--no-sync", "python", "db/seeds/seed_development.py"], environment)
        await admin.execute(
            f"CREATE ROLE \"{login_role}\" LOGIN PASSWORD '{role_password}' "
            "NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
        )
        role_created = True
        await admin.execute(f'GRANT platform_web TO "{login_role}"')
        parsed = urlsplit(target)
        host = f"[{parsed.hostname}]" if parsed.hostname == "::1" else parsed.hostname
        environment["DATABASE_URL"] = (
            f"postgresql://{login_role}:{quote(role_password)}@{host}:"
            f"{parsed.port or 5432}/{database}"
        )
        if check_db:
            environment["UI_TEST_DATABASE_URL"] = environment["DATABASE_URL"]
            result = run(["pnpm", "--filter", "@or-on/crm", "test"], environment)
            # On success print only the summary, not SQL or fixture payloads.
            for line in result.splitlines():
                if "Test Files" in line or "Tests " in line:
                    print(line, flush=True)
            print("Isolated PostgreSQL CRM tests passed as a platform_web member.", flush=True)
            return
        artifact.parent.mkdir(exist_ok=True)
        artifact.write_text(
            json.dumps(
                {
                    "email": environment["DEV_AUTH_EMAIL"],
                    "password": password,
                    "database": database,
                    "login_role": login_role,
                }
            ),
            encoding="utf-8",
        )
        artifact.chmod(0o600)
        print("Isolated PostgreSQL preview ready. No messaging/voice worker started.", flush=True)
        print(
            "Preview: http://127.0.0.1:3100 — "
            "temporary login in .artifacts/phase7-preview-login.json",
            flush=True,
        )
        # This CLI owns one child process; shutdown always reaps its process tree.
        child = subprocess.Popen(  # noqa: S603, ASYNC220
            _resolve_command(
                [
                    "pnpm",
                    "--filter",
                    "@or-on/web",
                    "exec",
                    "next",
                    "start" if production else "dev",
                    "--hostname",
                    "127.0.0.1",
                    "--port",
                    "3100",
                ]
            ),
            cwd=ROOT,
            env=environment,
            text=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        await asyncio.to_thread(child.wait)
        if child.returncode:
            raise RuntimeError("Preview web process exited unsuccessfully")
    finally:
        if child is not None and child.poll() is None:
            if os.name == "nt":
                subprocess.run(  # noqa: S603, ASYNC221 — reap only our owned child tree
                    ["taskkill", "/PID", str(child.pid), "/T", "/F"],  # noqa: S607
                    capture_output=True,
                    check=False,
                )  # noqa: S603,S607
            else:
                child.terminate()
            child.wait(timeout=15)
        if created:
            await admin.execute(f'DROP DATABASE "{database}" WITH (FORCE)')
        if role_created:
            await admin.execute(f'DROP ROLE "{login_role}"')
        await admin.close()
        if not check_db:
            artifact.unlink(missing_ok=True)
        print(
            "Owned preview database/login removed; developer database and .env untouched.",
            flush=True,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check-db", action="store_true", help="Run CRM tests in an owned fixture DB"
    )
    parser.add_argument(
        "--production", action="store_true", help="Preview existing Next production output"
    )
    arguments = parser.parse_args()
    try:
        asyncio.run(main(check_db=arguments.check_db, production=arguments.production))
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(
            f"UI preview unavailable ({type(error).__name__}). "
            "Check Docker/PostgreSQL and local dependencies.",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
