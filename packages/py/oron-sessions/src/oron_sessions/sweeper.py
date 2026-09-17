"""Fail sessions left `started` by an agent that died without finalizing.

Intended to run periodically through the deployment scheduler by calling
`oron-sessions-sweeper`.

The sweep is one call to `platform.fail_stale_voice_sessions`, made as the
voice runtime role that already owns session lifecycle writes. `sessions` is
under forced RLS, so an unscoped UPDATE from a runtime role matches nothing and
logs exactly like a quiet night; the definer function is the one bounded place
allowed to see every tenant's stale rows. It takes nothing but the threshold,
so the credential this job holds cannot read or change anything else — unlike
the historical Or-on tenancy login, which still holds DML on users,
memberships and api_keys and must stay dormant.
"""

import asyncio
import datetime as dt
import logging

from oron_db import make_engine, make_sessionmaker
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

logger = logging.getLogger(__name__)

_DRIVER = "postgresql+asyncpg"
# Mirrors the function's own guard: below an hour a live call could be failed.
_MIN_MINUTES = 60
_MAX_MINUTES = 10080


class SweeperSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    database_url: str = Field(validation_alias="DATABASE_URL")
    stale_session_minutes: int = Field(
        default=120,
        ge=_MIN_MINUTES,
        le=_MAX_MINUTES,
        validation_alias="STALE_SESSION_MINUTES",
    )

    @property
    def async_database_url(self) -> str:
        for prefix in ("postgresql://", "postgres://"):
            if self.database_url.startswith(prefix):
                return f"{_DRIVER}://{self.database_url.removeprefix(prefix)}"
        return self.database_url


async def sweep(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    older_than: dt.timedelta,
) -> int:
    """Fail every tenant's stale sessions. Returns how many rows were failed."""

    minutes = int(older_than.total_seconds() // 60)
    if not _MIN_MINUTES <= minutes <= _MAX_MINUTES:
        raise ValueError("stale session threshold must be between 1 hour and 7 days")
    async with sessionmaker() as session, session.begin():
        failed = int(
            await session.scalar(
                text("SELECT platform.fail_stale_voice_sessions(:minutes)"),
                {"minutes": minutes},
            )
            or 0
        )
    logger.info("failed %d stale session(s) older than %s", failed, older_than)
    return failed


async def sweep_once() -> int:
    settings = SweeperSettings()  # pyrefly: ignore[missing-argument]
    engine = make_engine(settings.async_database_url)
    try:
        return await sweep(
            make_sessionmaker(engine),
            older_than=dt.timedelta(minutes=settings.stale_session_minutes),
        )
    finally:
        await engine.dispose()


def main() -> None:
    from oron_secrets import hydrate_env_from_secret_manager

    logging.basicConfig(level=logging.INFO)
    # resolve SECRET__DATABASE_URL before settings load
    hydrate_env_from_secret_manager()
    asyncio.run(sweep_once())


if __name__ == "__main__":
    main()
