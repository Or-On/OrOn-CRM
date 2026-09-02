import json
import uuid

import httpx
from oron_common import CallContext, CallUsage
from oron_sessions import SessionsClient

TENANT_ID = uuid.UUID("00000000-0000-0000-0000-0000000000aa")

FLOW_ID = uuid.uuid4()

SID = uuid.uuid4()


def _handler_factory(calls: list):
    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path, request.content.decode()))
        if request.method == "POST":
            return httpx.Response(201, json={"session_id": str(SID)})
        return httpx.Response(200, json={"session_id": str(SID), "status": "ended"})

    return handler


async def test_create_posts_session_create_body():
    calls: list = []
    http = httpx.AsyncClient(
        base_url="http://s", transport=httpx.MockTransport(_handler_factory(calls))
    )
    client = SessionsClient("http://s", client=http)

    ctx = CallContext(
        call_id="call-1",
        direction="outbound",
        to_number="+15551230000",
        flow_id=FLOW_ID,
        tenant_id=TENANT_ID,
    )
    sid = await client.create(ctx, room="call-1")

    assert sid == SID
    method, path, body = calls[0]
    assert (method, path) == ("POST", "/sessions")
    b = body.replace(" ", "")
    assert '"direction":"outbound"' in b and '"room":"call-1"' in b
    await client.aclose()


async def test_create_sends_the_tenant_from_the_context():
    """The agent used to send none at all, and a service key without X-Tenant-Id
    is a 400 — so every session write it made failed on a live call."""
    seen: dict = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["tenant"] = request.headers.get("X-Tenant-Id")
        return httpx.Response(201, json={"session_id": str(SID)})

    http = httpx.AsyncClient(base_url="http://s", transport=httpx.MockTransport(handler))
    client = SessionsClient("http://s", client=http)
    ctx = CallContext(call_id="call-1", direction="outbound", flow_id=FLOW_ID, tenant_id=TENANT_ID)
    await client.create(ctx, room="r1")
    assert seen["tenant"] == str(TENANT_ID)
    await client.aclose()


async def test_finalize_sends_tenant_header():
    seen: dict = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["tenant"] = request.headers.get("X-Tenant-Id")
        return httpx.Response(200, json={"session_id": str(SID), "status": "ended"})

    http = httpx.AsyncClient(base_url="http://s", transport=httpx.MockTransport(handler))
    client = SessionsClient("http://s", client=http)
    tid = uuid.uuid4()
    assert await client.finalize(SID, tenant_id=tid) is True
    assert seen["tenant"] == str(tid)
    await client.aclose()


async def test_a_finalize_without_usage_omits_it_rather_than_sending_zeros():
    """The dispatcher finalizes rows it never observed. Sending a default-zero
    CallUsage would overwrite whatever the agent already reported."""
    seen: dict = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"session_id": str(SID), "status": "ended"})

    http = httpx.AsyncClient(base_url="http://s", transport=httpx.MockTransport(handler))
    client = SessionsClient("http://s", client=http)
    assert await client.finalize(SID) is True
    assert "usage" not in seen["body"]

    assert await client.finalize(SID, usage=CallUsage(llm_prompt_tokens=7)) is True
    assert seen["body"]["usage"]["llm_prompt_tokens"] == 7
    await client.aclose()


async def test_api_key_sets_authorization_header_on_owned_client():
    client = SessionsClient("http://s", api_key="oron_secret")
    assert client._client.headers["Authorization"] == "Bearer oron_secret"
    await client.aclose()


async def test_create_returns_none_when_api_unreachable():
    async def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    http = httpx.AsyncClient(base_url="http://s", transport=httpx.MockTransport(handler))
    client = SessionsClient("http://s", client=http, attempts=2, backoff_seconds=0)

    ctx = CallContext(call_id="call-1", direction="inbound", flow_id=FLOW_ID, tenant_id=TENANT_ID)
    # Must not raise — a persistence outage cannot be what ends a call.
    assert await client.create(ctx, room="r1") is None
    await client.aclose()


async def test_finalize_returns_false_on_server_error():
    http = httpx.AsyncClient(
        base_url="http://s",
        transport=httpx.MockTransport(lambda r: httpx.Response(503)),
    )
    client = SessionsClient("http://s", client=http, attempts=2, backoff_seconds=0)

    assert await client.finalize(SID) is False
    await client.aclose()


async def test_retries_transient_then_succeeds():
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        if attempts["n"] == 1:
            return httpx.Response(503)
        return httpx.Response(200, json={"session_id": str(SID), "status": "ended"})

    http = httpx.AsyncClient(base_url="http://s", transport=httpx.MockTransport(handler))
    client = SessionsClient("http://s", client=http, attempts=3, backoff_seconds=0)

    assert await client.finalize(SID) is True
    assert attempts["n"] == 2
    await client.aclose()


async def test_does_not_retry_permanent_client_error():
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(400, json={"detail": "service key requires X-Tenant-Id"})

    http = httpx.AsyncClient(base_url="http://s", transport=httpx.MockTransport(handler))
    client = SessionsClient("http://s", client=http, attempts=3, backoff_seconds=0)

    ctx = CallContext(call_id="call-1", direction="inbound", flow_id=FLOW_ID, tenant_id=TENANT_ID)
    assert await client.create(ctx, room="r1") is None
    assert attempts["n"] == 1  # a 4xx is permanent — retrying wastes call time
    await client.aclose()


async def test_an_existing_row_is_the_row_to_report_against():
    """The dispatcher creates the row, then the agent posts the same session_id
    and gets a 409. Reading that as failure is what left every finished call with
    no usage, no duration and no artifact URIs — the agent skipped its finalize.
    """
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(409, json={"detail": "session_id already exists"})

    http = httpx.AsyncClient(base_url="http://s", transport=httpx.MockTransport(handler))
    client = SessionsClient("http://s", client=http, attempts=3, backoff_seconds=0)

    ctx = CallContext(call_id="call-1", direction="inbound", flow_id=FLOW_ID, tenant_id=TENANT_ID)
    assert await client.create(ctx, room="r1") == ctx.session_id
    assert attempts["n"] == 1
    await client.aclose()


async def test_finalize_patches_status():
    calls: list = []
    http = httpx.AsyncClient(
        base_url="http://s", transport=httpx.MockTransport(_handler_factory(calls))
    )
    client = SessionsClient("http://s", client=http)

    await client.finalize(SID, transcript_uri="gs://oron/x/transcript.txt")

    method, path, body = calls[0]
    assert method == "PATCH"
    assert path == f"/sessions/{SID}"
    b = body.replace(" ", "")
    assert '"status":"ended"' in b
    assert '"transcript_uri":"gs://oron/x/transcript.txt"' in b
    await client.aclose()
