"""Safety contracts for fictional preview fixtures without a database connection."""

import http.client
import json
import re
from collections import Counter
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from scripts.preview_ui_browser import PreviewBrowserLogin, trusted_browser_request
from scripts.preview_ui_fixtures import (
    fixture_id,
    seed_preview_fixtures,
    validate_fixture_database,
)


def test_preview_fixture_ids_are_stable_and_distinct() -> None:
    assert fixture_id("contact-0") == fixture_id("contact-0")
    assert fixture_id("contact-0") != fixture_id("conversation-0")


@pytest.mark.asyncio
async def test_broadcast_fixtures_leave_status_counts_to_the_recipient_trigger() -> None:
    connection = MagicMock()
    connection.fetchval = AsyncMock(return_value="oron_ui_preview_abc")
    connection.execute = AsyncMock()
    connection.close = AsyncMock()
    connection.transaction.return_value.__aenter__ = AsyncMock()
    connection.transaction.return_value.__aexit__ = AsyncMock()
    with patch(
        "scripts.preview_ui_fixtures.asyncpg.connect", new=AsyncMock(return_value=connection)
    ):
        await seed_preview_fixtures(
            "postgresql://fixture@127.0.0.1/oron_ui_preview_abc", "oron_ui_preview_abc"
        )
    broadcasts = {}
    recipients = {}
    for call in connection.execute.call_args_list:
        query, *values = call.args
        match = re.match(
            r"INSERT INTO messaging\.(broadcasts|broadcast_recipients) \(([^)]+)\)", query
        )
        if match is None:
            continue
        row = dict(zip(match[2].split(", "), values, strict=True))
        if match[1] == "broadcasts":
            broadcasts[row["id"]] = row
        else:
            recipients.setdefault(row["broadcast_id"], Counter()).update([row["status"]])
    assert len(broadcasts) == 4
    for broadcast_id, broadcast in broadcasts.items():
        statuses = recipients[broadcast_id]
        assert sum(statuses.values()) == broadcast["total_recipients"] == 8
        # The schema trigger adds one to the current status bucket for every
        # INSERT. The fixture must use zero defaults, not cumulative preloads.
        for status in ("sent", "delivered", "read", "replied", "failed"):
            assert broadcast.get(f"{status}_count", 0) == 0
        if broadcast["status"] == "sent":
            assert statuses == {"delivered": 8}
        elif broadcast["status"] == "failed":
            assert statuses == {"failed": 2, "pending": 6}
        else:
            assert statuses == {"pending": 8}
    connection.close.assert_awaited_once()


def test_owned_fixture_destination_is_accepted() -> None:
    validate_fixture_database(
        "postgresql://fixture@127.0.0.1/oron_ui_preview_abc", "oron_ui_preview_abc"
    )


@pytest.mark.asyncio
async def test_lead_fixtures_cover_scoped_mixed_language_directory_states() -> None:
    connection = MagicMock()
    connection.fetchval = AsyncMock(return_value="oron_ui_preview_abc")
    connection.execute = AsyncMock()
    connection.close = AsyncMock()
    connection.transaction.return_value.__aenter__ = AsyncMock()
    connection.transaction.return_value.__aexit__ = AsyncMock()
    with patch(
        "scripts.preview_ui_fixtures.asyncpg.connect", new=AsyncMock(return_value=connection)
    ):
        await seed_preview_fixtures(
            "postgresql://fixture@127.0.0.1/oron_ui_preview_abc", "oron_ui_preview_abc"
        )
    leads = []
    for call in connection.execute.call_args_list:
        query, *values = call.args
        match = re.match(r"INSERT INTO crm\.leads \(([^)]+)\)", query)
        if match:
            leads.append(dict(zip(match[1].split(", "), values, strict=True)))
    assert len(leads) == 6
    assert {row["source_channel"] for row in leads} == {"voice", "whatsapp", "manual", "api"}
    assert {row["status"] for row in leads} >= {
        "new",
        "collecting",
        "ready_for_review",
        "qualified",
    }
    assert any("הדגמה" in row["business_objective"] for row in leads)
    for index, row in enumerate(leads):
        assert str(row["tenant_id"]) == "10000000-0000-4000-8000-000000000001"
        assert row["contact_id"] == fixture_id(f"contact-{index}")
        assert row["reference"].startswith("LD-PREVIEW")


@pytest.mark.asyncio
async def test_settings_fixture_metadata_is_scoped_and_has_no_usable_credentials() -> None:
    connection = MagicMock()
    connection.fetchval = AsyncMock(return_value="oron_ui_preview_abc")
    connection.execute = AsyncMock()
    connection.close = AsyncMock()
    connection.transaction.return_value.__aenter__ = AsyncMock()
    connection.transaction.return_value.__aexit__ = AsyncMock()
    with patch(
        "scripts.preview_ui_fixtures.asyncpg.connect", new=AsyncMock(return_value=connection)
    ):
        routes = await seed_preview_fixtures(
            "postgresql://fixture@127.0.0.1/oron_ui_preview_abc", "oron_ui_preview_abc"
        )
    rows: dict[str, list[dict]] = {}
    for call in connection.execute.call_args_list:
        query, *values = call.args
        match = re.match(
            r"INSERT INTO (platform\.tenant_invitations|public\.api_keys|messaging\.notifications) "
            r"\(([^)]+)\)",
            query,
        )
        if match:
            rows.setdefault(match[1], []).append(
                dict(zip(match[2].split(", "), values, strict=True))
            )
    keys = rows["public.api_keys"]
    assert len(keys) == 2
    assert {key["status"] for key in keys} == {"active", "revoked"}
    assert len({key["hashed_key"] for key in keys}) == 2
    for key in keys:
        assert re.fullmatch(r"[a-f0-9]{64}", key["hashed_key"])
        assert key["kind"] == "tenant"
        assert str(key["tenant_id"]) == "10000000-0000-4000-8000-000000000001"
        assert (key["status"] == "revoked") == (key["revoked_at"] is not None)
        assert "token" not in key
        assert key["hashed_key"] not in str(routes)
    invitation = rows["platform.tenant_invitations"][0]
    assert invitation["email"].endswith("@example.invalid")
    assert re.fullmatch(r"[a-f0-9]{64}", invitation["token_hash"])
    assert invitation["token_hash"] not in str(routes)
    notifications = rows["messaging.notifications"]
    assert len(notifications) == 2
    assert sum(note["read_at"] is None for note in notifications) == 1
    assert all(
        str(note["user_id"]) == "20000000-0000-4000-8000-000000000001" for note in notifications
    )
    connection.close.assert_awaited_once()


@pytest.mark.parametrize(
    "url,database",
    [
        ("postgresql://fixture@127.0.0.1/developer", "developer"),
        ("postgresql://fixture@example.com/oron_ui_preview_abc", "oron_ui_preview_abc"),
        ("postgresql://fixture@127.0.0.1/oron_ui_preview_other", "oron_ui_preview_abc"),
        ("postgresql://fixture@127.0.0.1/oron_ui_preview_", "oron_ui_preview_"),
        ("postgresql://fixture@127.0.0.1/oron_ui_preview_a-b", "oron_ui_preview_a-b"),
    ],
)
def test_fixture_seed_rejects_unowned_destinations(url: str, database: str) -> None:
    with pytest.raises(ValueError):
        validate_fixture_database(url, database)


@pytest.mark.parametrize(
    "host,site,origin,expected",
    [
        ("127.0.0.1:3101", "none", None, True),
        ("127.0.0.1:3101", "same-site", "http://127.0.0.1:3100", True),
        ("127.0.0.1:3101", "cross-site", None, False),
        ("evil.example", "none", None, False),
        ("127.0.0.1:3101", "none", "https://evil.example", False),
    ],
)
def test_browser_bootstrap_rejects_host_and_cross_site_requests(
    host: str,
    site: str,
    origin: str | None,
    expected: bool,
) -> None:
    assert trusted_browser_request(host, site, origin) is expected


def test_browser_bootstrap_cannot_handle_a_real_account() -> None:
    with pytest.raises(ValueError, match="fictional"):
        PreviewBrowserLogin(
            database_url="postgresql://fixture@127.0.0.1/oron_ui_preview_abc",
            database="oron_ui_preview_abc",
            email="person@example.com",
            password="x" * 32,
        )


def test_browser_bootstrap_binds_loopback_and_does_not_start_until_requested() -> None:
    with patch("scripts.preview_ui_browser.ThreadingHTTPServer") as server_type:
        bootstrap = PreviewBrowserLogin(
            database_url="postgresql://fixture@127.0.0.1/oron_ui_preview_abc",
            database="oron_ui_preview_abc",
            email="demo@example.invalid",
            password="f" * 32,
        )
        assert server_type.call_args.args[0] == ("127.0.0.1", 3101)
        assert not bootstrap.thread.is_alive()
        bootstrap.close()
        server_type.return_value.server_close.assert_called_once()


def test_browser_bootstrap_calls_real_auth_contract_and_relays_only_cookie_headers() -> None:
    with patch("scripts.preview_ui_browser.ThreadingHTTPServer") as server_type:
        PreviewBrowserLogin(
            database_url="postgresql://fixture@127.0.0.1/oron_ui_preview_abc",
            database="oron_ui_preview_abc",
            email="demo@example.invalid",
            password="f" * 32,
        )
        handler_type = server_type.call_args.args[1]
    handler = MagicMock()
    handler.path = "/fictional-preview"
    handler.headers = {"Host": "127.0.0.1:3101", "Sec-Fetch-Site": "none"}
    with patch("scripts.preview_ui_browser.http.client.HTTPConnection") as connection_type:
        connection = connection_type.return_value
        response = connection.getresponse.return_value
        response.status = 200
        response.headers.get_all.return_value = [
            "fixture_cookie=not-a-real-token; HttpOnly; Path=/"
        ]
        handler_type.do_GET(handler)
        args, kwargs = connection.request.call_args
        assert args == ("POST", "/api/auth/login")
        assert json.loads(kwargs["body"])["email"] == "demo@example.invalid"
        assert kwargs["headers"]["Origin"] == "http://127.0.0.1:3100"
        handler.send_response.assert_called_once_with(303)
        handler.send_header.assert_any_call("Location", "http://127.0.0.1:3100/")
        handler.send_header.assert_any_call("Cache-Control", "no-store")
        connection.close.assert_called_once()


@pytest.mark.parametrize("status,cookies", [(503, []), (200, [])])
def test_browser_bootstrap_does_not_redirect_on_failed_auth(
    status: int, cookies: list[str]
) -> None:
    with patch("scripts.preview_ui_browser.ThreadingHTTPServer") as server_type:
        PreviewBrowserLogin(
            database_url="postgresql://fixture@127.0.0.1/oron_ui_preview_abc",
            database="oron_ui_preview_abc",
            email="demo@example.invalid",
            password="f" * 32,
        )
        handler_type = server_type.call_args.args[1]
    handler = MagicMock()
    handler.path = "/fictional-preview"
    handler.headers = {"Host": "127.0.0.1:3101"}
    with patch("scripts.preview_ui_browser.http.client.HTTPConnection") as connection_type:
        response = connection_type.return_value.getresponse.return_value
        response.status = status
        response.headers.get_all.return_value = cookies
        handler_type.do_GET(handler)
        handler.send_error.assert_called_once()
        handler.send_response.assert_not_called()


def test_browser_bootstrap_reports_no_transport_error_details() -> None:
    with patch("scripts.preview_ui_browser.ThreadingHTTPServer") as server_type:
        PreviewBrowserLogin(
            database_url="postgresql://fixture@127.0.0.1/oron_ui_preview_abc",
            database="oron_ui_preview_abc",
            email="demo@example.invalid",
            password="f" * 32,
        )
        handler_type = server_type.call_args.args[1]
    handler = MagicMock()
    handler.path = "/fictional-preview"
    handler.headers = {"Host": "127.0.0.1:3101"}
    with patch("scripts.preview_ui_browser.http.client.HTTPConnection") as connection_type:
        connection_type.return_value.request.side_effect = http.client.HTTPException("sensitive")
        handler_type.do_GET(handler)
        assert "sensitive" not in str(handler.send_error.call_args)


def test_owned_stop_endpoint_requests_launcher_cleanup_without_logging_credentials() -> None:
    stop = MagicMock()
    with patch("scripts.preview_ui_browser.ThreadingHTTPServer") as server_type:
        PreviewBrowserLogin(
            database_url="postgresql://fixture@127.0.0.1/oron_ui_preview_abc",
            database="oron_ui_preview_abc",
            email="demo@example.invalid",
            password="f" * 32,
            on_stop=stop,
        )
        handler_type = server_type.call_args.args[1]
    handler = MagicMock()
    handler.path = "/stop"
    handler.headers = {"Host": "127.0.0.1:3101", "Origin": "http://127.0.0.1:3101"}
    handler_type.do_POST(handler)
    handler.send_response.assert_called_once_with(204)
    stop.assert_called_once()


def test_cross_site_stop_request_cannot_interrupt_an_owned_preview() -> None:
    stop = MagicMock()
    with patch("scripts.preview_ui_browser.ThreadingHTTPServer") as server_type:
        PreviewBrowserLogin(
            database_url="postgresql://fixture@127.0.0.1/oron_ui_preview_abc",
            database="oron_ui_preview_abc",
            email="demo@example.invalid",
            password="f" * 32,
            on_stop=stop,
        )
        handler_type = server_type.call_args.args[1]
    handler = MagicMock()
    handler.path = "/stop"
    handler.headers = {"Host": "127.0.0.1:3101", "Sec-Fetch-Site": "cross-site"}
    handler_type.do_POST(handler)
    handler.send_error.assert_called_once()
    stop.assert_not_called()
