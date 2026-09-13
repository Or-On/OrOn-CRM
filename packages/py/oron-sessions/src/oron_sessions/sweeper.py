"""Fail sessions left `started` by an agent that died without finalizing.

Intended to run periodically through the deployment scheduler by calling
`oron-sessions-sweeper`.

Swept one tenant at a time, because `sessions` is under RLS. An unscoped UPDATE
matches nothing once the app connects as a non-superuser: the policy compares
`tenant_id` against an unset GUC, which is NULL, so no row evaluates TRUE and the
statement succeeds having changed nothing. That failure is invisible — the log
line is identical to a quiet night — so scoping is not optional here, even though
it costs a transaction per tenant.

The GUC is transaction-scoped, so a transaction per tenant is required anyway; it
also means one tenant's failure cannot roll back another's sweep.
"""

import asyncio
import datetime as dt
import logging

from oron_db import make_engine, make_sessionmaker, set_tenant
from oron_tenancy.models import Tenant
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col

from oron_sessions import crud
from oron_sessions.config import load_settings

logger = logging.getLogger(__name__)


async def sweep(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    control_sessionmaker: async_sessionmaker[AsyncSession],
    older_than: dt.timedelta,
) -> int:
    """Fail every tenant's stale sessions. Returns how many rows were failed.

    Takes sessionmakers rather than building them, so the tests can run it
    through the non-superuser roles that RLS actually applies to — swept as a
    superuser this would pass while the deployed job silently did nothing.

    Two of them because the sweep spans both planes: the tenant list is a
    control-plane read, and only the tenancy role is granted `tenants`.
    """
    # `tenants` is control-plane and carries no policy, so this read needs no
    # scoping — it is what supplies the scopes.
    async with control_sessionmaker() as session:
        tenant_ids = list((await session.execute(select(col(Tenant.id)))).scalars())

    failed = 0
    for tenant_id in tenant_ids:
        async with sessionmaker() as session, session.begin():
            # crud flushes; the caller owns the transaction. In a request that is
            # get_tenant_db — here the sweeper owns it.
            await set_tenant(session, tenant_id)
            failed += await crud.fail_stale_sessions(session=session, older_than=older_than)
    logger.info(
        "failed %d stale session(s) older than %s across %d tenant(s)",
        failed,
        older_than,
        len(tenant_ids),
    )
    return failed


async def sweep_once() -> int:
    st = load_settings()
    engine = make_engine(st.database_url)
    control_engine = make_engine(st.control_database_url)
    try:
        return await sweep(
            make_sessionmaker(engine),
            control_sessionmaker=make_sessionmaker(control_engine),
            older_than=dt.timedelta(minutes=st.stale_session_minutes),
        )
    finally:
        await engine.dispose()
        await control_engine.dispose()


def main() -> None:
    from oron_secrets import hydrate_env_from_secret_manager

    logging.basicConfig(level=logging.INFO)
    # resolve SECRET__DATABASE_URL / SECRET__CONTROL_DATABASE_URL before settings load
    hydrate_env_from_secret_manager()
    asyncio.run(sweep_once())


if __name__ == "__main__":
    main()
