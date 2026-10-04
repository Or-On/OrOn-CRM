from __future__ import annotations

from typing import cast

import asyncpg
import pytest

from scripts.queue_health import main, snapshot


class Transaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


class Connection:
    def transaction(self, *, readonly):
        assert readonly is True
        return Transaction()

    async def execute(self, query):
        assert query == "SET LOCAL statement_timeout='5s'"

    async def fetchrow(self, query):
        assert "payload" not in query
        return {"due": 3, "oldest_due_seconds": 121.25, "dead": 1, "expired_running": 2}


@pytest.mark.asyncio
async def test_snapshot_is_read_only_and_content_free():
    assert await snapshot(cast(asyncpg.Connection, Connection())) == {
        "due": 3,
        "oldest_due_seconds": 121.25,
        "dead": 1,
        "expired_running": 2,
    }


@pytest.mark.asyncio
async def test_monitor_never_falls_back_to_application_secret(monkeypatch, capsys):
    monkeypatch.delenv("QUEUE_MONITOR_DATABASE_URL", raising=False)
    monkeypatch.setenv("DATABASE_URL", "secret-application-credential")
    assert await main() == 2
    assert "secret" not in capsys.readouterr().out


@pytest.mark.asyncio
async def test_connection_failure_redacts_exception(monkeypatch, capsys):
    async def fail(*_args, **_kwargs):
        raise ValueError("postgresql://secret:password@host/production")

    monkeypatch.setenv("QUEUE_MONITOR_DATABASE_URL", "synthetic")
    monkeypatch.setattr("scripts.queue_health.asyncpg.connect", fail)
    assert await main() == 2
    output = capsys.readouterr().out
    assert '"error_type": "ValueError"' in output
    assert "password" not in output
