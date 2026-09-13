"""Optional loopback-only session bootstrap for the fictional UI test preview.

Uses the real login endpoint and relays its cookies on the same host. It never
changes application authentication, makes a provider call, or handles a real
account. This endpoint exists only for the lifetime of the owned preview CLI.
"""

from __future__ import annotations

import http.client
import json
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

from scripts.preview_ui_fixtures import validate_fixture_database

BOOTSTRAP_HOST = "127.0.0.1:3101"
APPLICATION_HOST = "127.0.0.1:3100"
BOOTSTRAP_PATH = "/fictional-preview"


def trusted_browser_request(host: str | None, fetch_site: str | None, origin: str | None) -> bool:
    return (
        host == BOOTSTRAP_HOST
        and fetch_site in {None, "none", "same-origin", "same-site"}
        and origin in {None, f"http://{BOOTSTRAP_HOST}", f"http://{APPLICATION_HOST}"}
    )


class PreviewBrowserLogin:
    def __init__(
        self,
        *,
        database_url: str,
        database: str,
        email: str,
        password: str,
        on_stop: Callable[[], None] | None = None,
    ) -> None:
        validate_fixture_database(database_url, database)
        if email != "demo@example.invalid" or len(password) < 24:
            raise ValueError("Browser bootstrap is restricted to the generated fictional account")

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: object) -> None:
                # HTTP access logs can contain credentials, cookies, or query values.
                return

            def do_GET(self) -> None:  # noqa: N802 — stdlib HTTP handler contract
                if self.path != BOOTSTRAP_PATH or not trusted_browser_request(
                    self.headers.get("Host"),
                    self.headers.get("Sec-Fetch-Site"),
                    self.headers.get("Origin"),
                ):
                    self.send_error(403, "Fictional preview bootstrap request rejected")
                    return
                connection = http.client.HTTPConnection(APPLICATION_HOST, timeout=15)
                try:
                    connection.request(
                        "POST",
                        "/api/auth/login",
                        body=json.dumps({"email": email, "password": password}),
                        headers={
                            "Content-Type": "application/json",
                            "Origin": f"http://{APPLICATION_HOST}",
                            "Host": APPLICATION_HOST,
                            "Sec-Fetch-Site": "same-origin",
                            "User-Agent": "OrOn-Fictional-Preview",
                        },
                    )
                    response = connection.getresponse()
                    response.read()
                    cookies = response.headers.get_all("Set-Cookie") or []
                    if response.status != 200 or not cookies:
                        self.send_error(
                            503,
                            "Fictional preview login is not ready; retry after web startup",
                        )
                        return
                    self.send_response(303)
                    for cookie in cookies:
                        self.send_header("Set-Cookie", cookie)
                    self.send_header("Location", f"http://{APPLICATION_HOST}/")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Referrer-Policy", "no-referrer")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                except OSError, http.client.HTTPException:
                    self.send_error(503, "Fictional preview web server is unavailable")
                finally:
                    connection.close()

            def do_POST(self) -> None:  # noqa: N802 — stdlib HTTP handler contract
                if (
                    self.path != "/stop"
                    or on_stop is None
                    or not trusted_browser_request(
                        self.headers.get("Host"),
                        self.headers.get("Sec-Fetch-Site"),
                        self.headers.get("Origin"),
                    )
                ):
                    self.send_error(403, "Fictional preview stop request rejected")
                    return
                self.send_response(204)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                on_stop()

        self.server = ThreadingHTTPServer(("127.0.0.1", 3101), Handler)
        self.thread = Thread(
            target=self.server.serve_forever, daemon=True, name="fictional-preview-browser-login"
        )

    def start(self) -> None:
        self.thread.start()

    def close(self) -> None:
        if self.thread.is_alive():
            self.server.shutdown()
            self.thread.join(timeout=5)
        self.server.server_close()
