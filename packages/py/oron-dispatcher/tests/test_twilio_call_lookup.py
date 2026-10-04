"""Exercise provider response framing and identity gates over loopback HTTP."""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from uuid import UUID

import aiohttp
import pytest
from aiohttp import web
from oron_dispatcher import twilio_inbound as subject

CALL_SID = "CA" + "2" * 32
CALLER = "+14155550100"


def _route() -> subject.TwilioInboundRoute:
    return subject.TwilioInboundRoute(
        tenant_id=UUID(int=1),
        account_sid="AC" + "1" * 32,
        auth_token="fictional-token-0123456789",
        phone_number_sid="PN" + "1" * 32,
        did="+14155550101",
        trunk_id="ST_fixture",
        sip_host="fixture.sip.invalid",
        auth_username="fictional-username-1",
        auth_password="fictional-password-1",
    )


def _active_call(binding: subject.TwilioInboundRoute) -> dict[str, str]:
    return {
        "sid": CALL_SID,
        "account_sid": binding.account_sid,
        "phone_number_sid": binding.phone_number_sid,
        "to": binding.did,
        "from": CALLER,
        "direction": "inbound",
        "status": "ringing",
    }


@asynccontextmanager
async def _provider(monkeypatch, binding, payload: bytes, *, status: int = 200):
    """Keep production URL/auth construction; redirect only the test socket."""
    requests = []
    finished = asyncio.Event()

    async def respond(request):
        requests.append(request.path)
        response = web.StreamResponse(
            status=status,
            headers={"Content-Type": "application/json", "Location": "/unexpected-redirect"},
        )
        try:
            await response.prepare(request)
            # StreamReader.read(n) can return this first available fragment,
            # although a valid provider response has not reached EOF yet.
            await response.write(payload[:9])
            await asyncio.sleep(0.01)
            await response.write(payload[9:])
            await response.write_eof()
        except ConnectionResetError:
            # Expected when the lookup refuses status/size before body EOF.
            pass
        finally:
            finished.set()
        return response

    app = web.Application()
    app.router.add_get("/call", respond)
    app.router.add_get("/unexpected-redirect", respond)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    assert site._server is not None
    port = site._server.sockets[0].getsockname()[1]
    real_session = aiohttp.ClientSession

    class LoopbackSession:
        def __init__(self, **kwargs):
            self.client = real_session(**kwargs)

        async def __aenter__(self):
            await self.client.__aenter__()
            return self

        async def __aexit__(self, *args):
            return await self.client.__aexit__(*args)

        def get(self, url, **kwargs):
            assert url == (
                "https://api.twilio.com/2010-04-01/Accounts/"
                f"{binding.account_sid}/Calls/{CALL_SID}.json"
            )
            assert kwargs.get("allow_redirects") is False
            return self.client.get(f"http://127.0.0.1:{port}/call", **kwargs)

    monkeypatch.setattr(subject.aiohttp, "ClientSession", LoopbackSession)
    try:
        yield requests
    finally:
        await asyncio.wait_for(finished.wait(), 2)
        await runner.cleanup()


@pytest.mark.parametrize(
    "changes,expected",
    [
        ({}, True),
        ({"status": "queued"}, True),
        ({"status": "in-progress"}, True),
        ({"sid": "CA" + "8" * 32}, False),
        ({"account_sid": "AC" + "8" * 32}, False),
        ({"phone_number_sid": "PN" + "8" * 32}, False),
        ({"to": "+14155550102"}, False),
        ({"from": "+14155550103"}, False),
        ({"direction": "outbound-api"}, False),
        ({"status": "completed"}, False),
        ({"status": "failed"}, False),
        ({"status": "canceled"}, False),
    ],
)
async def test_fragmented_call_response_enforces_exact_identity(monkeypatch, changes, expected):
    binding = _route()
    payload = json.dumps({**_active_call(binding), **changes}).encode()
    async with _provider(monkeypatch, binding, payload) as requests:
        assert await subject.TwilioCallLookup().active(binding, CALL_SID, CALLER) is expected
    assert requests == ["/call"]


@pytest.mark.parametrize("status", [302, 404, 503])
async def test_call_lookup_does_not_follow_redirects_or_accept_provider_failure(
    monkeypatch, status
):
    binding = _route()
    payload = json.dumps(_active_call(binding)).encode()
    async with _provider(monkeypatch, binding, payload, status=status) as requests:
        if status == 404:
            assert await subject.TwilioCallLookup().active(binding, CALL_SID, CALLER) is False
        else:
            with pytest.raises(RuntimeError, match="verification unavailable"):
                await subject.TwilioCallLookup().active(binding, CALL_SID, CALLER)
    assert requests == ["/call"]


@pytest.mark.parametrize(
    "payload,error",
    [(b"x" * 65_537, RuntimeError), (b"[]", RuntimeError), (b"not-json", ValueError)],
    ids=["oversize", "nonobject", "invalid-json"],
)
async def test_call_lookup_bounds_and_validates_response_body(monkeypatch, payload, error):
    binding = _route()
    async with _provider(monkeypatch, binding, payload) as requests:
        with pytest.raises(error):
            await subject.TwilioCallLookup().active(binding, CALL_SID, CALLER)
    assert requests == ["/call"]
