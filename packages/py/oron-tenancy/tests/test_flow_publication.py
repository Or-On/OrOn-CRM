"""Publication arbitrates uniqueness without changing frozen flow content."""

import uuid
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from oron_flows.components import SPEC_VERSION
from oron_flows.compose import expand
from oron_flows.seeds import EXAMPLE_HE_ID, composition_for
from oron_tenancy.flow_store import FlowVersionConflict, PostgresFlowStore
from sqlalchemy.dialects import postgresql


def _store(monkeypatch, *, inserted: bool, existing=None):
    insert_result, select_result = Mock(), Mock()
    insert_result.first.return_value = (EXAMPLE_HE_ID,) if inserted else None
    select_result.scalars.return_value.first.return_value = existing
    session = AsyncMock()
    session.execute.side_effect = [insert_result, select_result]

    @asynccontextmanager
    async def scoped(tenant_id):
        yield session

    store = PostgresFlowStore(Mock())
    monkeypatch.setattr(store, "_scoped", scoped)
    return store, session


async def test_first_publication_is_insert_only(monkeypatch):
    composition = composition_for(EXAMPLE_HE_ID)
    store, session = _store(monkeypatch, inserted=True)

    assert await store.publish(str(uuid.uuid4()), composition) == composition.flow.version

    statement = session.execute.call_args_list[0].args[0]
    sql = str(statement.compile(dialect=postgresql.dialect()))
    assert "ON CONFLICT (flow_id, version) DO NOTHING" in sql
    assert "DO UPDATE" not in sql
    assert session.execute.await_count == 1


@pytest.mark.parametrize("mismatch", [None, "source", "spec", "components_version", "hidden"])
async def test_existing_publication_requires_identical_frozen_content(monkeypatch, mismatch):
    composition = composition_for(EXAMPLE_HE_ID)
    existing = SimpleNamespace(
        source=composition.model_dump(mode="json"),
        spec=expand(composition).model_dump(mode="json"),
        components_version=SPEC_VERSION,
    )
    if mismatch == "hidden":
        existing = None
    elif mismatch:
        setattr(existing, mismatch, "different")
    store, session = _store(monkeypatch, inserted=False, existing=existing)
    tenant_id = uuid.uuid4()

    if mismatch:
        with pytest.raises(FlowVersionConflict, match="bump the version"):
            await store.publish(str(tenant_id), composition)
    else:
        assert await store.publish(str(tenant_id), composition) == composition.flow.version

    lookup = session.execute.call_args_list[1].args[0].compile(dialect=postgresql.dialect())
    assert tenant_id in lookup.params.values()
    assert "flows.tenant_id =" in str(lookup)
