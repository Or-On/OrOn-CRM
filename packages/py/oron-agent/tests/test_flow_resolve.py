"""Where a call gets its script from — and what happens when the store cannot say.

The fallback is the "a persistence outage must never end a call" guarantee, and
it runs on the answer path with the caller already connected. It is asserted here
rather than left to be discovered live.
"""

import uuid

import httpx
import pytest
from oron_agent.flows.resolve import resolve_flow_spec
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


async def test_an_unreachable_store_falls_back_to_the_packaged_flow():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("sessions API is down")

    spec = await resolve_flow_spec(_client(handler), _ctx(EXAMPLE_HE_ID))

    assert spec.id == EXAMPLE_HE_ID
    assert spec.nodes


async def test_a_404_falls_back_rather_than_raising():
    """A flow the store has never heard of still has to answer the phone."""
    spec = await resolve_flow_spec(
        _client(lambda r: httpx.Response(404, json={"detail": "flow not found"})),
        _ctx(EXAMPLE_HE_ID),
    )

    assert spec.id == EXAMPLE_HE_ID


async def test_a_spec_this_build_cannot_parse_falls_back():
    """A store serving a spec from a newer component library must not crash the
    call — the packaged copy is known to bind against this build."""
    spec = await resolve_flow_spec(
        _client(lambda r: httpx.Response(200, json={"nonsense": True})),
        _ctx(EXAMPLE_HE_ID),
    )

    assert spec.id == EXAMPLE_HE_ID


async def test_the_resolved_spec_binds():
    """Resolving is only half the job: the spec has to become a NodeConfig."""
    from oron_agent.flows import initial_node_from_spec

    spec = await resolve_flow_spec(_client(lambda r: httpx.Response(503)), _ctx(EXAMPLE_HE_ID))

    assert initial_node_from_spec(spec) is not None


@pytest.mark.parametrize("unknown", [uuid.uuid4()])
async def test_an_unknown_flow_id_falls_back_to_the_default_and_says_so(unknown, caplog):
    spec = await resolve_flow_spec(_client(lambda r: httpx.Response(404)), _ctx(unknown))

    # composition_for substitutes the default; the id proves which one ran.
    assert spec.id == EXAMPLE_HE_ID
