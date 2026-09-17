"""The stale-session sweeper is the deployment's last repair for a call the
dispatcher could not durably finalize, and it is scheduled hourly in DEV.

The database side (`platform.fail_stale_voice_sessions`) is proven against
PostgreSQL in db/tests/postgres/test_stale_session_sweep.py. These cover the
job itself: one bounded call, inside a transaction, with a threshold that can
never fail a live call, over a DSN the async engine can actually open.
"""

from __future__ import annotations

import datetime as dt
from contextlib import asynccontextmanager

import pytest
from oron_db import make_engine
from oron_sessions import sweeper
from pydantic import ValidationError


class _Session:
    def __init__(self, journal: list, result: object):
        self._journal = journal
        self._result = result
        self.in_transaction = False

    async def scalar(self, statement, parameters):
        assert self.in_transaction, "the sweep must run inside a transaction"
        self._journal.append((str(statement), dict(parameters)))
        return self._result

    def begin(self):
        @asynccontextmanager
        async def _transaction():
            self.in_transaction = True
            try:
                yield self
            finally:
                self.in_transaction = False
                self._journal.append("commit")

        return _transaction()


def _sessionmaker(journal: list, result: object = 3):
    @asynccontextmanager
    async def _open():
        yield _Session(journal, result)

    return _open


@pytest.mark.asyncio
async def test_one_bounded_definer_call_in_one_transaction() -> None:
    journal: list = []

    failed = await sweeper.sweep(_sessionmaker(journal), older_than=dt.timedelta(minutes=120))

    assert failed == 3
    assert journal == [
        ("SELECT platform.fail_stale_voice_sessions(:minutes)", {"minutes": 120}),
        "commit",
    ]


@pytest.mark.asyncio
async def test_a_null_result_is_zero_not_an_error() -> None:
    assert await sweeper.sweep(_sessionmaker([], None), older_than=dt.timedelta(hours=2)) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("older_than", [dt.timedelta(minutes=59), dt.timedelta(days=8)])
async def test_a_threshold_that_could_fail_live_calls_never_reaches_the_database(
    older_than,
) -> None:
    journal: list = []
    with pytest.raises(ValueError, match="between 1 hour and 7 days"):
        await sweeper.sweep(_sessionmaker(journal), older_than=older_than)
    assert journal == []


def test_settings_need_only_the_voice_dsn_and_select_the_async_driver(monkeypatch) -> None:
    for name in ("CONTROL_DATABASE_URL", "STALE_SESSION_MINUTES"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(
        "DATABASE_URL", "postgresql://platform_voice:fictional@postgres:5432/or_on_platform"
    )

    settings = sweeper.SweeperSettings()  # pyrefly: ignore[missing-argument]

    assert settings.stale_session_minutes == 120
    assert settings.async_database_url.startswith("postgresql+asyncpg://platform_voice:")
    assert make_engine(settings.async_database_url).dialect.driver == "asyncpg"


@pytest.mark.parametrize("minutes", ["30", "20000"])
def test_settings_reject_an_unsafe_threshold(monkeypatch, minutes) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://platform_voice:fictional@postgres/db")
    monkeypatch.setenv("STALE_SESSION_MINUTES", minutes)
    with pytest.raises(ValidationError):
        sweeper.SweeperSettings()  # pyrefly: ignore[missing-argument]
