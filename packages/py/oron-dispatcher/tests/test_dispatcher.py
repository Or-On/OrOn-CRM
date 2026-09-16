from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import NAMESPACE_URL, uuid4, uuid5

import pytest
from livekit.protocol.models import ParticipantInfo
from oron_dispatcher.dispatcher import (
    AgentStartupUnavailable,
    Dispatcher,
    IdempotencyConflict,
    PersistenceUnavailable,
)
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

    class Handle:
        async def cancel(self) -> None:
            return None

    launch = AsyncMock(return_value=Handle())
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
            caller_gender="male",
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
            caller_gender="male",
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
            caller_gender="male",
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
            caller_gender="male",
        )

    launch.assert_not_awaited()
    dial.assert_not_awaited()


async def test_agent_startup_failure_is_safe_and_never_reaches_sip() -> None:
    dial = AsyncMock()
    sip = _sip(enabled=True, dial=dial)
    dispatcher, sessions, launch, _ = _dispatcher(sip=sip)
    launch.side_effect = RuntimeError("https://secret-endpoint.invalid?token=secret")

    with pytest.raises(AgentStartupUnavailable, match="startup preflight failed") as captured:
        await dispatcher.place_outbound_call(
            "+14155550100",
            TENANT_ID,
            FLOW_ID,
            idempotency_key="request-agent-startup-failure",
            explicit_approval=True,
            caller_gender="male",
        )

    assert "secret" not in str(captured.value)
    sessions.finalize.assert_awaited_once()
    dial.assert_not_awaited()


async def test_runtime_agent_failure_hangs_up_and_marks_session_failed() -> None:
    dial = AsyncMock()
    dispatcher, sessions, launch, hangup = _dispatcher(sip=_sip(enabled=True, dial=dial))
    observer = None

    class Handle:
        async def cancel(self) -> None:
            return None

        def observe_completion(self, callback) -> None:
            nonlocal observer
            observer = callback

    launch.return_value = Handle()
    result = await dispatcher.place_outbound_call(
        "+14155550100",
        TENANT_ID,
        FLOW_ID,
        idempotency_key="request-runtime-failure",
        explicit_approval=True,
    )
    assert result.created
    assert observer is not None
    observer(RuntimeError("provider disconnected"))
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    hangup.assert_awaited_once()
    sessions.finalize.assert_awaited_once()
    assert sessions.finalize.await_args.kwargs["status"].value == "failed"


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
        caller_gender="male",
    )

    assert result.created is False
    sessions.begin.assert_awaited_once()
    launch.assert_not_awaited()
    dial.assert_not_awaited()


async def test_outbound_carries_secure_cross_channel_references_into_the_agent() -> None:
    dial = AsyncMock()
    dispatcher, sessions, launch, _ = _dispatcher(sip=_sip(enabled=True, dial=dial))
    conversation_id = uuid4()
    contact_id = uuid4()
    handoff_id = uuid4()

    await dispatcher.place_outbound_call(
        "+14155550100",
        TENANT_ID,
        FLOW_ID,
        idempotency_key="request-gender-context",
        explicit_approval=True,
        caller_gender="female",
        contact_id=contact_id,
        source_conversation_id=conversation_id,
        handoff_id=handoff_id,
    )

    context = sessions.begin.await_args.args[0]
    assert context.caller_gender == "female"
    assert context.contact_id == contact_id
    assert context.source_conversation_id == conversation_id
    assert context.handoff_id == handoff_id
    assert launch.await_args.args[1].caller_gender == "female"
    assert launch.await_args.args[1].handoff_id == handoff_id
    dial.assert_awaited_once()


async def test_outbound_pins_agent_and_flow_versions_through_persistence_and_launch() -> None:
    dial = AsyncMock()
    dispatcher, sessions, launch, _ = _dispatcher(sip=_sip(enabled=True, dial=dial))
    agent_version_id = uuid4()
    kwargs = {
        "idempotency_key": "request-pinned-version",
        "explicit_approval": True,
        "flow_version": 4,
        "agent_version_id": agent_version_id,
    }
    created = await dispatcher.place_outbound_call("+14155550100", TENANT_ID, FLOW_ID, **kwargs)
    replay = await dispatcher.place_outbound_call("+14155550100", TENANT_ID, FLOW_ID, **kwargs)
    assert created.created and not replay.created
    assert sessions.begin.await_args.args[0].flow_version == 4
    assert sessions.begin.await_args.args[0].agent_version_id == agent_version_id
    assert launch.await_args.args[1].flow_version == 4
    assert launch.await_args.args[1].agent_version_id == agent_version_id
    dial.assert_awaited_once()


@pytest.mark.parametrize("changed", ["agent_version_id", "flow_version"])
async def test_active_idempotency_key_cannot_be_rebound_to_another_published_version(changed):
    dial = AsyncMock()
    dispatcher, sessions, launch, _ = _dispatcher(sip=_sip(enabled=True, dial=dial))
    kwargs = {
        "idempotency_key": "request-conflicting-version",
        "explicit_approval": True,
        "flow_version": 1,
        "agent_version_id": uuid4(),
    }
    await dispatcher.place_outbound_call("+14155550100", TENANT_ID, FLOW_ID, **kwargs)
    kwargs[changed] = 2 if changed == "flow_version" else uuid4()
    with pytest.raises(IdempotencyConflict):
        await dispatcher.place_outbound_call("+14155550100", TENANT_ID, FLOW_ID, **kwargs)
    sessions.begin.assert_awaited_once()
    launch.assert_awaited_once()
    dial.assert_awaited_once()
