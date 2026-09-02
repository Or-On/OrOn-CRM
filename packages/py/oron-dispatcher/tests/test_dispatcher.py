from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import NAMESPACE_URL, uuid4, uuid5

import pytest
from livekit.protocol.models import ParticipantInfo
from oron_dispatcher.dispatcher import Dispatcher, PersistenceUnavailable
from oron_dispatcher.sip_client import RealTelephonyDenied, SipClient
from oron_dispatcher.tenancy_client import PhoneResolution

TENANT_ID = uuid4()
FLOW_ID = uuid4()
DID = "+97235550000"


def _sip(*, enabled: bool, trunk_id: str | None = "ST_test", dial: AsyncMock | None = None):
    client = SipClient(
        url="ws://127.0.0.1:7880",
        api_key="test-key",
        api_secret="test-secret-test-secret-test-secret",
        trunk_id=trunk_id,
        enabled=enabled,
    )
    if dial is not None:
        client.dial = dial  # type: ignore[method-assign]
    return client


def _dispatcher(
    *,
    begin: AsyncMock | None = None,
    resolve: AsyncMock | None = None,
    sip: SipClient | None = None,
):
    sessions = SimpleNamespace(
        begin=begin or AsyncMock(return_value=True),
        finalize=AsyncMock(return_value=True),
        ready=AsyncMock(return_value=True),
    )
    launch = AsyncMock(return_value=AsyncMock())
    hangup = AsyncMock()
    dispatcher = Dispatcher(
        settings=SimpleNamespace(room_prefix="call-", bot_identity="oron-agent"),
        sessions=sessions,
        sip_client=sip or _sip(enabled=False),
        launch_bot=launch,
        resolve_phone=resolve
        or AsyncMock(return_value=PhoneResolution(tenant_id=TENANT_ID, flow_id=FLOW_ID)),
        hangup_room=hangup,
        mint_token=Mock(return_value="room-token"),
    )
    return dispatcher, sessions, launch, hangup


def _participant_event(*, did: str | None = DID, room: str = "call-inbound"):
    attributes = {"sip.phoneNumber": "+14155550100"}
    if did is not None:
        attributes["sip.trunkPhoneNumber"] = did
    return SimpleNamespace(
        event="participant_joined",
        id="EV_test",
        room=SimpleNamespace(name=room),
        participant=SimpleNamespace(kind=ParticipantInfo.SIP, attributes=attributes),
    )


async def test_inbound_resolves_before_persisting_and_launches_once() -> None:
    dispatcher, sessions, launch, hangup = _dispatcher()
    event = _participant_event()

    await dispatcher.handle_participant_joined(event)
    await dispatcher.handle_participant_joined(event)

    sessions.begin.assert_awaited_once()
    launch.assert_awaited_once()
    hangup.assert_not_awaited()
    context = sessions.begin.await_args.args[0]
    assert context.tenant_id == TENANT_ID
    assert context.flow_id == FLOW_ID
    assert context.session_id == uuid5(NAMESPACE_URL, "or-on-platform:livekit-room:call-inbound")


@pytest.mark.parametrize("did", [None, "+000", "+14155550101"])
async def test_unknown_malformed_or_missing_did_is_rejected_before_session(did: str | None) -> None:
    resolver = AsyncMock(return_value=None)
    dispatcher, sessions, launch, hangup = _dispatcher(resolve=resolver)

    await dispatcher.handle_participant_joined(_participant_event(did=did))

    sessions.begin.assert_not_awaited()
    launch.assert_not_awaited()
    hangup.assert_awaited_once_with("call-inbound")


async def test_inbound_persistence_failure_hangs_up_before_agent_launch() -> None:
    begin = AsyncMock(side_effect=PersistenceUnavailable("database unavailable"))
    dispatcher, _sessions, launch, hangup = _dispatcher(begin=begin)

    with pytest.raises(PersistenceUnavailable):
        await dispatcher.handle_participant_joined(_participant_event())

    launch.assert_not_awaited()
    hangup.assert_awaited_once_with("call-inbound")


async def test_recovered_inbound_claim_hangs_up_when_session_already_exists() -> None:
    dispatcher, sessions, launch, hangup = _dispatcher(begin=AsyncMock(return_value=False))

    await dispatcher.handle_participant_joined(_participant_event())

    sessions.begin.assert_awaited_once()
    launch.assert_not_awaited()
    hangup.assert_awaited_once_with("call-inbound")


async def test_outbound_is_denied_before_persistence_when_real_telephony_is_off() -> None:
    dispatcher, sessions, launch, _hangup = _dispatcher(sip=_sip(enabled=False))

    with pytest.raises(RealTelephonyDenied, match="disabled"):
        await dispatcher.place_outbound_call(
            "+14155550100",
            TENANT_ID,
            FLOW_ID,
            idempotency_key="request-0001",
            explicit_approval=True,
        )

    sessions.begin.assert_not_awaited()
    launch.assert_not_awaited()


async def test_outbound_requires_explicit_approval_and_trunk() -> None:
    no_approval, sessions, _, _ = _dispatcher(sip=_sip(enabled=True))
    with pytest.raises(RealTelephonyDenied, match="explicit"):
        await no_approval.place_outbound_call(
            "+14155550100",
            TENANT_ID,
            FLOW_ID,
            idempotency_key="request-0002",
            explicit_approval=False,
        )
    sessions.begin.assert_not_awaited()

    no_trunk, sessions, _, _ = _dispatcher(sip=_sip(enabled=True, trunk_id=None))
    with pytest.raises(RealTelephonyDenied, match="trunk"):
        await no_trunk.place_outbound_call(
            "+14155550100",
            TENANT_ID,
            FLOW_ID,
            idempotency_key="request-0003",
            explicit_approval=True,
        )
    sessions.begin.assert_not_awaited()


async def test_outbound_persistence_failure_never_reaches_sip() -> None:
    dial = AsyncMock()
    begin = AsyncMock(side_effect=PersistenceUnavailable("database unavailable"))
    sip = _sip(enabled=True, dial=dial)
    dispatcher, _, launch, _ = _dispatcher(begin=begin, sip=sip)

    with pytest.raises(PersistenceUnavailable):
        await dispatcher.place_outbound_call(
            "+14155550100",
            TENANT_ID,
            FLOW_ID,
            idempotency_key="request-0004",
            explicit_approval=True,
        )

    launch.assert_not_awaited()
    dial.assert_not_awaited()


async def test_outbound_replay_does_not_launch_or_dial() -> None:
    dial = AsyncMock()
    dispatcher, sessions, launch, _ = _dispatcher(
        begin=AsyncMock(return_value=False), sip=_sip(enabled=True, dial=dial)
    )

    result = await dispatcher.place_outbound_call(
        "+14155550100",
        TENANT_ID,
        FLOW_ID,
        idempotency_key="request-0005",
        explicit_approval=True,
    )

    assert result.created is False
    sessions.begin.assert_awaited_once()
    launch.assert_not_awaited()
    dial.assert_not_awaited()
