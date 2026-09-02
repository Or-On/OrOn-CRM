import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

TENANT_GUC = "app.current_tenant"


async def set_tenant(session: AsyncSession, tenant_id: uuid.UUID | str) -> None:
    """Set the tenant GUC that RLS policies read, scoped to the current
    transaction.

    Transaction-scoped is the whole point: Postgres clears it on commit or
    rollback, so a pooled connection can never carry one request's tenant into
    the next. A session-scoped setting would need an explicit reset on teardown,
    and a single missed reset is a cross-tenant data leak.

    `set_config` rather than `SET` because plain `SET` cannot take bind
    parameters — this way the tenant id is a bound value, never interpolated
    into SQL.
    """
    await session.execute(select(func.set_config(TENANT_GUC, str(tenant_id), True)))
