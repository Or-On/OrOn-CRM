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
from threading import Thread
from urllib.parse import quote, urlsplit, urlunsplit
from uuid import uuid4

import asyncpg

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.dev import _load_environment, _resolve_command  # noqa: E402
from scripts.preview_ui_browser import PreviewBrowserLogin  # noqa: E402
from scripts.preview_ui_fixtures import seed_preview_fixtures  # noqa: E402
from scripts.preview_voice_fixtures import seed_preview_voice  # noqa: E402


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
        if (
            command == ["pnpm", "--filter", "@or-on/crm", "test"]
            or command[-1] == "tests/diagnostics.live.test.ts"
        ):
            diagnostic = completed.stdout + completed.stderr
            for key, value in environment.items():
                if any(word in key for word in ("URL", "PASSWORD", "SECRET", "PEPPER")) and value:
                    diagnostic = diagnostic.replace(value, "[REDACTED]")
            print(diagnostic, file=sys.stderr)
        # Child output may include connection parameters; do not echo it.
        raise RuntimeError(f"Preview setup command failed: {command[0]}")
    return completed.stdout.strip()


async def main(
    *,
    check_db: bool = False,
    check_messaging: bool = False,
    production: bool = False,
    browser_login: bool = False,
) -> None:
    if production and not (ROOT / "apps/web/.next/BUILD_ID").is_file():
        raise ValueError("Production preview requires pnpm build first")
    if not check_db and not check_messaging:
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
    voice_child: subprocess.Popen[str] | None = None
    voice_role = f"oron_ui_voice_{uuid4().hex}"
    voice_role_created = False
    browser: PreviewBrowserLogin | None = None
    created = False
    role_created = False
    stop_requested = asyncio.Event()
    loop = asyncio.get_running_loop()
    try:
        await admin.execute(f'CREATE DATABASE "{database}"')
        created = True
        environment = {
            key: value
            for key, value in os.environ.items()
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
        # These fixtures never enter the developer seed or application runtime.
        # Verification-only databases keep their existing test-owned fixtures.
        fixture_routes = (
            {} if check_db or check_messaging else await seed_preview_fixtures(target, database)
        )
        if not check_db and not check_messaging:
            fixture_routes.update(await seed_preview_voice(target, database))
        await admin.execute(
            f"CREATE ROLE \"{login_role}\" LOGIN PASSWORD '{role_password}' "
            "NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
        )
        role_created = True
        runtime_role = "platform_messaging" if check_messaging else "platform_web"
        await admin.execute(f'GRANT {runtime_role} TO "{login_role}"')
        parsed = urlsplit(target)
        host = f"[{parsed.hostname}]" if parsed.hostname == "::1" else parsed.hostname
        environment["DATABASE_URL"] = (
            f"postgresql://{login_role}:{quote(role_password)}@{host}:"
            f"{parsed.port or 5432}/{database}"
        )
        if not check_db and not check_messaging:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 3102))
            voice_password = secrets.token_hex(24)
            await admin.execute(
                f"CREATE ROLE \"{voice_role}\" LOGIN PASSWORD '{voice_password}' "
                "NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
            )
            voice_role_created = True
            await admin.execute(f'GRANT platform_voice TO "{voice_role}"')
            voice_environment = {
                **environment,
                "VOICE_DATABASE_URL": (
                    f"postgresql://{voice_role}:{quote(voice_password)}@{host}:"
                    f"{parsed.port or 5432}/{database}"
                ),
                "PREVIEW_DATABASE_NAME": database,
            }
            voice_child = subprocess.Popen(  # noqa: S603, ASYNC220
                _resolve_command(
                    [
                        "uv",
                        "run",
                        "--no-sync",
                        "uvicorn",
                        "scripts.preview_voice_api:create_app",
                        "--factory",
                        "--host",
                        "127.0.0.1",
                        "--port",
                        "3102",
                        "--no-access-log",
                    ]
                ),
                cwd=ROOT,
                env=voice_environment,
                text=True,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            environment["CONTROL_API_URL"] = "http://127.0.0.1:3102"
        if check_messaging:
            environment["MESSAGING_DIAGNOSTICS_TEST_DATABASE_URL"] = target
            environment["MESSAGING_DIAGNOSTICS_RUNTIME_DATABASE_URL"] = environment["DATABASE_URL"]
            result = run(
                [
                    "pnpm",
                    "--filter",
                    "@or-on/messaging-worker",
                    "exec",
                    "vitest",
                    "run",
                    "tests/diagnostics.live.test.ts",
                ],
                environment,
            )
            for line in result.splitlines():
                if "Test Files" in line or "Tests " in line:
                    print(line, flush=True)
            print(
                "Isolated messaging diagnostics passed. All provider HTTP was mocked.", flush=True
            )
            return
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
                    "fixture_routes": fixture_routes,
                }
            ),
            encoding="utf-8",
        )
        artifact.chmod(0o600)
        if browser_login:

            def request_browser_stop() -> None:
                loop.call_soon_threadsafe(stop_requested.set)

            browser = PreviewBrowserLogin(
                database_url=target,
                database=database,
                email=environment["DEV_AUTH_EMAIL"],
                password=password,
                on_stop=request_browser_stop,
            )
            browser.start()
        print("Isolated PostgreSQL preview ready. No messaging/voice worker started.", flush=True)
        print(
            "Preview: http://127.0.0.1:3100 — "
            "temporary login in .artifacts/phase7-preview-login.json",
            flush=True,
        )
        if browser_login:
            print("Fictional browser session: http://127.0.0.1:3101/fictional-preview", flush=True)
        # This CLI owns one child process; shutdown always reaps its process tree.
        child = subprocess.Popen(  # noqa: S603, ASYNC220
            _resolve_command(
                [
                    "node",
                    str(ROOT / "apps/web/node_modules/next/dist/bin/next"),
                    "start" if production else "dev",
                    "--hostname",
                    "127.0.0.1",
                    "--port",
                    "3100",
                ]
            ),
            cwd=ROOT / "apps/web",
            env=environment,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )

        def relay_web_output() -> None:
            assert child is not None and child.stdout is not None
            for line in child.stdout:
                for key, value in environment.items():
                    if (
                        any(word in key for word in ("URL", "PASSWORD", "SECRET", "PEPPER", "HASH"))
                        and value
                    ):
                        line = line.replace(value, "[REDACTED]")
                print(line.rstrip().encode("ascii", "backslashreplace").decode("ascii"), flush=True)

        Thread(target=relay_web_output, daemon=True, name="fictional-preview-web-output").start()
        web_finished = asyncio.create_task(asyncio.to_thread(child.wait))
        stop_signal = asyncio.create_task(stop_requested.wait())
        await asyncio.wait((web_finished, stop_signal), return_when=asyncio.FIRST_COMPLETED)
        stop_signal.cancel()
        if web_finished.done() and child.returncode:
            raise RuntimeError("Preview web process exited unsuccessfully")
    finally:
        if browser is not None:
            browser.close()
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
            if voice_child is not None and voice_child.poll() is None:
                if os.name == "nt":
                    subprocess.run(  # noqa: S603, ASYNC221
                        ["taskkill", "/PID", str(voice_child.pid), "/T", "/F"],  # noqa: S607
                        capture_output=True,
                        check=False,
                    )
                else:
                    voice_child.terminate()
                voice_child.wait(timeout=15)
            await admin.execute(f'DROP DATABASE "{database}" WITH (FORCE)')
        if voice_role_created:
            await admin.execute(f'DROP ROLE "{voice_role}"')
        if role_created:
            await admin.execute(f'DROP ROLE "{login_role}"')
        await admin.close()
        if not check_db and not check_messaging:
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
    parser.add_argument(
        "--browser-login",
        action="store_true",
        help="Enable temporary loopback browser login for the generated fictional account",
    )
    parser.add_argument(
        "--check-messaging",
        action="store_true",
        help="Run mocked-provider diagnostics on an owned database as platform_messaging",
    )
    arguments = parser.parse_args()
    try:
        if sum((arguments.check_db, arguments.check_messaging, arguments.production)) > 1:
            parser.error("Choose only one of --check-db, --check-messaging, or --production")
        if arguments.browser_login and (arguments.check_db or arguments.check_messaging):
            parser.error("--browser-login is available only for an interactive isolated preview")
        asyncio.run(
            main(
                check_db=arguments.check_db,
                check_messaging=arguments.check_messaging,
                production=arguments.production,
                browser_login=arguments.browser_login,
            )
        )
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(
            f"UI preview unavailable ({type(error).__name__}). "
            "Check Docker/PostgreSQL and local dependencies.",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
