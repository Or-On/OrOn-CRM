"""PostgreSQL-published flows are the only runtime voice configuration."""

import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from oron_flows.seeds import EXAMPLE_HE_ID, composition_for
from oron_sessions.api import publish_flow
from oron_sessions.app import create_app
from oron_tenancy import SipSettings
from oron_tenancy.flow_store import FlowVersionConflict


async def test_service_startup_does_not_publish_packaged_example_flows() -> None:
    flow_store = AsyncMock()
    app = create_app(
        sessionmaker=object(),  # type: ignore[arg-type]
        control_sessionmaker=object(),  # type: ignore[arg-type]
        sip_settings=SipSettings(livekit_url=None),
        field_cipher=object(),  # type: ignore[arg-type]
        blind_index_key=b"fixture" * 5,
        flow_store=flow_store,
    )

    async with app.router.lifespan_context(app):
        pass

    flow_store.publish.assert_not_awaited()


async def test_example_compositions_remain_explicitly_publishable_test_fixtures() -> None:
    """Keeping fixture builders does not reserve their IDs or seed runtime state."""

    store = AsyncMock()
    store.list_versions.return_value = []
    store.publish.return_value = 1
    tenant_id = uuid.uuid4()

    result = await publish_flow(composition_for(EXAMPLE_HE_ID), store, tenant_id)

    assert result.flow_id == EXAMPLE_HE_ID
    store.publish.assert_awaited_once()


async def test_concurrent_publish_conflict_returns_409() -> None:
    store = AsyncMock()
    store.list_versions.return_value = []
    store.publish.side_effect = FlowVersionConflict(
        "version 1 is already published; bump the version"
    )

    with pytest.raises(HTTPException) as raised:
        await publish_flow(composition_for(EXAMPLE_HE_ID), store, uuid.uuid4())

    assert raised.value.status_code == 409
