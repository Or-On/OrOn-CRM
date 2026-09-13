"""A call runs only the tenant-owned flow resolved from PostgreSQL."""

import uuid

import httpx
import pytest
from oron_agent.flows.resolve import StoredFlowUnavailable, resolve_flow_spec
from oron_common import CallContext
from oron_flows.compose import expand
from oron_flows.seeds import EXAMPLE_HE_ID, composition_for
from oron_sessions import SessionsClient

TENANT_ID = uuid.UUID("00000000-0000-0000-0000-0000000000aa")


def _ctx(flow_id: uuid.UUID) -> CallContext:
    return CallContext(call_id="c1", direction="inbound", flow_id=flow_id, tenant_id=TENANT_ID)


def _client(handler) -> SessionsClient:
    transport = httpx.MockTransport(handler)
    return SessionsClient(
        "http://sessions", client=httpx.AsyncClient(transport=transport, base_url="http://sessions")
    )


async def test_the_stored_spec_is_what_runs():
    """Not the packaged copy — otherwise a tenant's published edit never airs."""
    stored = expand(composition_for(EXAMPLE_HE_ID)).model_copy(update={"language": "en"})
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["tenant"] = request.headers.get("X-Tenant-Id")
        return httpx.Response(200, json=stored.model_dump(mode="json"))

    spec = await resolve_flow_spec(_client(handler), _ctx(EXAMPLE_HE_ID))

    assert spec.language == "en"
    assert seen["url"].endswith(f"/flows/{EXAMPLE_HE_ID}")
    assert seen["tenant"] == str(TENANT_ID)


async def test_an_unreachable_store_fails_closed():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("sessions API is down")

    with pytest.raises(StoredFlowUnavailable, match="published flow"):
        await resolve_flow_spec(_client(handler), _ctx(EXAMPLE_HE_ID))


async def test_a_404_fails_closed_instead_of_running_a_fictional_script():
    with pytest.raises(StoredFlowUnavailable, match="published flow"):
        await resolve_flow_spec(
            _client(lambda r: httpx.Response(404, json={"detail": "flow not found"})),
            _ctx(EXAMPLE_HE_ID),
        )


async def test_a_spec_this_build_cannot_parse_fails_closed():
    with pytest.raises(StoredFlowUnavailable, match="published flow"):
        await resolve_flow_spec(
            _client(lambda r: httpx.Response(200, json={"nonsense": True})),
            _ctx(EXAMPLE_HE_ID),
        )


async def test_a_transient_store_failure_does_not_substitute_packaged_behavior():
    with pytest.raises(StoredFlowUnavailable):
        await resolve_flow_spec(_client(lambda r: httpx.Response(503)), _ctx(EXAMPLE_HE_ID))


@pytest.mark.parametrize("unknown", [uuid.uuid4()])
async def test_an_unknown_flow_id_never_runs_the_default(unknown):
    with pytest.raises(StoredFlowUnavailable):
        await resolve_flow_spec(_client(lambda r: httpx.Response(404)), _ctx(unknown))
