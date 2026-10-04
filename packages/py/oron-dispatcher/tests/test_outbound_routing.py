"""Provider-adapter tests use synthetic trunks; never place a real call."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from livekit import api
from oron_dispatcher.config import DispatcherSettings
from oron_dispatcher.outbound_routing import OutboundRoute
from oron_dispatcher.sip_client import RealTelephonyDenied, SipClient
from pydantic import ValidationError


def _route(**changes):
    return OutboundRoute(
        **{
            "tenant_id": uuid4(),
            "account_ref": "carrier-a",
            "trunk_id": "ST_A",
            "from_number": "+14155550101",
            "address": "a.pstn.invalid",
            **changes,
        }
    )


def _client(*routes):
    provider = SimpleNamespace(
        sip=SimpleNamespace(
            list_outbound_trunk=AsyncMock(
                return_value=api.ListSIPOutboundTrunkResponse(
                    items=[
                        api.SIPOutboundTrunkInfo(
                            sip_trunk_id=r.trunk_id,
                            address=r.address,
                            numbers=[r.from_number],
                        )
                        for r in routes
                    ]
                )
            ),
            create_sip_participant=AsyncMock(),
        ),
        aclose=AsyncMock(),
    )
    factory = Mock(return_value=provider)
    return (
        SipClient(
            url="http://localhost.invalid",
            api_key="test",
            api_secret="test",
            routes=routes,
            enabled=True,
            api_factory=factory,
        ),
        provider,
        factory,
    )


async def _dial(client, route, **changes):
    await client.dial(
        **{
            "room": str(route.tenant_id),
            "phone_number": "+14155550199",
            "identity": "callee",
            "tenant_id": route.tenant_id,
            "route": route,
            "explicit_approval": True,
            **changes,
        }
    )


async def test_parallel_tenants_dial_explicit_authorized_trunk_and_sender():
    first = _route()
    second = _route(
        account_ref="carrier-b",
        trunk_id="ST_B",
        from_number="+14155550102",
        address="b.pstn.invalid",
    )
    client, provider, _ = _client(first, second)
    await asyncio.gather(_dial(client, first), _dial(client, second))
    requests = [c.args[0] for c in provider.sip.create_sip_participant.await_args_list]
    assert {(r.room_name, r.sip_trunk_id, r.sip_number) for r in requests} == {
        (str(first.tenant_id), "ST_A", first.from_number),
        (str(second.tenant_id), "ST_B", second.from_number),
    }
    assert {r.sip_call_to for r in requests} == {"+14155550199"}


async def test_forged_tenant_or_route_never_reaches_provider():
    route = _route()
    client, provider, factory = _client(route)
    with pytest.raises(RealTelephonyDenied, match="not configured"):
        await _dial(client, route, tenant_id=uuid4())
    with pytest.raises(RealTelephonyDenied, match="does not match"):
        await _dial(client, route.model_copy(update={"trunk_id": "ST_FOREIGN"}))
    factory.assert_not_called()
    provider.sip.create_sip_participant.assert_not_awaited()


@pytest.mark.parametrize(
    "change",
    [
        {"sip_trunk_id": "ST_FOREIGN"},
        {"numbers": ["+14155550199"]},
        {"address": "different-account.pstn.invalid"},
        {"numbers": []},
    ],
)
async def test_provider_binding_drift_fails_closed(change):
    route = _route()
    client, provider, _ = _client(route)
    provider.sip.list_outbound_trunk.return_value = api.ListSIPOutboundTrunkResponse(
        items=[
            api.SIPOutboundTrunkInfo(
                **{
                    "sip_trunk_id": route.trunk_id,
                    "address": route.address,
                    "numbers": [route.from_number],
                    **change,
                }
            )
        ]
    )
    with pytest.raises(RealTelephonyDenied, match="mismatch"):
        await _dial(client, route)
    provider.sip.create_sip_participant.assert_not_awaited()
    provider.aclose.assert_awaited_once()


async def test_warm_process_rechecks_provider_and_redacts_credential_failure():
    route = _route()
    client, provider, _ = _client(route)
    await _dial(client, route)
    provider.sip.list_outbound_trunk.side_effect = RuntimeError("secret token refused")
    with pytest.raises(RealTelephonyDenied, match="could not be verified") as denied:
        await _dial(client, route)
    assert "secret" not in str(denied.value)
    assert provider.sip.list_outbound_trunk.await_count == 2
    assert provider.sip.create_sip_participant.await_count == 1


def test_global_trunk_does_not_authorize_any_tenant():
    configured = DispatcherSettings(
        _env_file=None, SIP_OUTBOUND_TRUNK_ID="ST_LEGACY", VOICE_OUTBOUND_ROUTES_JSON=[]
    )
    client, _, factory = _client(*configured.outbound_routes)
    with pytest.raises(RealTelephonyDenied, match="not configured"):
        client.authorize(tenant_id=uuid4(), explicit_approval=True)
    assert not client.configured
    factory.assert_not_called()


@pytest.mark.parametrize("duplicate", ["tenant", "sender", "account", "trunk"])
def test_ambiguous_configuration_is_rejected(duplicate):
    first = _route()
    changes = {
        "tenant": {"tenant_id": first.tenant_id, "from_number": "+14155550102"},
        "sender": {},
        "account": {"from_number": "+14155550102", "address": "b.pstn.invalid"},
        "trunk": {"from_number": "+14155550102", "account_ref": "carrier-b"},
    }
    with pytest.raises(ValidationError):
        DispatcherSettings(
            _env_file=None,
            VOICE_OUTBOUND_ROUTES_JSON=[
                first,
                _route(**changes[duplicate]),
            ],
        )


def test_explicit_shared_trunk_requires_distinct_owned_senders():
    first = _route()
    second = _route(from_number="+14155550102")
    settings = DispatcherSettings(_env_file=None, VOICE_OUTBOUND_ROUTES_JSON=[first, second])
    assert len(settings.outbound_routes) == 2
    assert settings.diagnostics()["outbound_route_count"] == 2
    assert first.from_number not in str(settings.diagnostics())
