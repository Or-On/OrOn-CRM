import uuid
from collections.abc import AsyncIterator

from fastapi import Depends, Request
from oron_common import PriceBook
from oron_db import set_tenant
from oron_flows import FlowStore
from oron_tenancy import require_tenant
from sqlalchemy.ext.asyncio import AsyncSession

from oron_sessions.crypto import FieldCipher


async def get_tenant_db(
    request: Request, tenant_id: uuid.UUID = Depends(require_tenant)
) -> AsyncIterator[AsyncSession]:
    """Yield a DB session scoped to the resolved tenant, inside one transaction
    for the whole request.

    One transaction per request is what makes the transaction-scoped GUC viable:
    `crud` flushes rather than commits, so the setting stays in force for every
    statement and Postgres clears it automatically at commit or rollback.
    Nothing has to remember to reset it, so nothing can forget.
    """
    sm = request.app.state.sessionmaker
    async with sm() as session, session.begin():
        await set_tenant(session, tenant_id)
        yield session


async def get_flow_store(request: Request) -> FlowStore:
    return request.app.state.flow_store


async def get_field_cipher(request: Request) -> FieldCipher:
    return request.app.state.field_cipher


async def get_blind_index_key(request: Request) -> bytes:
    return request.app.state.blind_index_key


def get_price_book(request: Request) -> PriceBook:
    """Built once at boot, not per request."""
    return request.app.state.price_book
