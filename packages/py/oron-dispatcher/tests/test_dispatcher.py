from __future__ import annotations

import asyncio
from pathlib import Path
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
    UnroutableInboundCall,
)
from oron_dispatcher.sip_client import RealTelephonyDenied, SipClient
from oron_dispatcher.tenancy_client import PhoneResolution
from oron_sessions import SessionStatus

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

    with pytest.raises(UnroutableInboundCall) as rejected:
        await dispatcher.handle_participant_joined(_participant_event(did=did))

    sessions.begin.assert_not_awaited()
    launch.assert_not_awaited()
    hangup.assert_awaited_once_with("call-inbound")
    expected = {None: "missing_did", "+000": "malformed_did", "+14155550101": "unregistered_did"}
    assert rejected.value.reason == expected[did]


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


def _room_finished(room: str = "call-inbound"):
    return SimpleNamespace(room=SimpleNamespace(name=room))


async def test_failed_finalization_still_releases_the_room() -> None:
    """A room whose finalization fails must not stay a phantom active call.

    The agent task is already cancelled, so leaving the entry in `_active` both
    refused the next inbound call on that room and inflated the active-call count
    for the lifetime of the process.
    """

    dispatcher, sessions, _launch, _hangup = _dispatcher()
    await dispatcher.handle_participant_joined(_participant_event())
    assert len(dispatcher.active_calls()) == 1

    sessions.finalize = AsyncMock(return_value=False)
    with pytest.raises(PersistenceUnavailable):
        await dispatcher.handle_room_finished(_room_finished())

    assert dispatcher.active_calls() == []


async def test_webhook_redelivery_retries_the_write_a_transient_outage_lost() -> None:
    """Releasing runtime ownership must not discard the durable completion.

    The webhook answers 503 on the raise, so LiveKit redelivers; that redelivery
    finds no active call and must still settle the status write.
    """

    dispatcher, sessions, _launch, _hangup = _dispatcher()
    await dispatcher.handle_participant_joined(_participant_event())

    sessions.finalize = AsyncMock(return_value=False)
    with pytest.raises(PersistenceUnavailable):
        await dispatcher.handle_room_finished(_room_finished())

    sessions.finalize = AsyncMock(return_value=True)
    await dispatcher.handle_room_finished(_room_finished())

    sessions.finalize.assert_awaited_once()
    assert sessions.finalize.await_args.kwargs["status"] is SessionStatus.ENDED
    assert dispatcher.active_calls() == []

    # Settled: a third delivery writes nothing at all.
    sessions.finalize = AsyncMock(return_value=True)
    await dispatcher.handle_room_finished(_room_finished())
    sessions.finalize.assert_not_awaited()


async def test_a_recorded_failure_is_not_relabelled_ended_by_a_later_delivery() -> None:
    """A dial that failed recorded FAILED; room_finished passes ENDED. The first
    observation is the truth about how the call ended."""

    dial = AsyncMock(side_effect=RuntimeError("carrier refused"))
    dispatcher, sessions, _launch, _hangup = _dispatcher(sip=_sip(enabled=True, dial=dial))
    sessions.finalize = AsyncMock(return_value=False)

    with pytest.raises(PersistenceUnavailable):
        await dispatcher.place_outbound_call(
            "+14155550123",
            TENANT_ID,
            FLOW_ID,
            idempotency_key="outbound-key-1",
            explicit_approval=True,
        )

    room = dispatcher._unfinalized  # noqa: SLF001 — the durable-intent record
    assert [status for _context, status in room.values()] == [SessionStatus.FAILED]

    sessions.finalize = AsyncMock(return_value=True)
    await dispatcher.handle_room_finished(_room_finished(next(iter(room))))
    assert sessions.finalize.await_args.kwargs["status"] is SessionStatus.FAILED


async def test_a_failed_dial_tears_down_the_room_before_finalizing() -> None:
    """A dial request that errors client-side may still have created the SIP leg.
    The room must be deleted so no paid leg rings into a bot-less room, and the
    session is still recorded failed even if that hangup itself raises."""

    dial = AsyncMock(side_effect=TimeoutError("request timed out"))
    dispatcher, sessions, _launch, hangup = _dispatcher(sip=_sip(enabled=True, dial=dial))
    order: list[str] = []
    hangup.side_effect = lambda room: order.append(f"hangup:{room}") or _raise_teardown()
    sessions.finalize = AsyncMock(side_effect=lambda *a, **k: order.append("finalize") or True)

    with pytest.raises(TimeoutError):
        await dispatcher.place_outbound_call(
            "+14155550123",
            TENANT_ID,
            FLOW_ID,
            idempotency_key="outbound-timeout-1",
            explicit_approval=True,
        )

    assert len(order) == 2
    assert order[0].startswith("hangup:call-")
    assert order[1] == "finalize"
    assert sessions.finalize.await_args.kwargs["status"] is SessionStatus.FAILED
    assert dispatcher.active_calls() == []


def _raise_teardown() -> None:
    raise ConnectionError("livekit unreachable")


async def test_the_unfinalized_record_is_bounded() -> None:
    """A sustained outage must not grow an unbounded map; the sweeper repairs
    whatever is evicted."""

    dispatcher, sessions, _launch, _hangup = _dispatcher()
    sessions.finalize = AsyncMock(return_value=False)

    for index in range(300):
        room = f"call-{index}"
        await dispatcher.handle_participant_joined(_participant_event(room=room))
        with pytest.raises(PersistenceUnavailable):
            await dispatcher.handle_room_finished(_room_finished(room))

    assert len(dispatcher._unfinalized) == 256  # noqa: SLF001
    assert dispatcher.active_calls() == []


async def test_the_room_is_dispatchable_again_once_its_write_lands() -> None:
    dispatcher, sessions, _launch, _hangup = _dispatcher()
    await dispatcher.handle_participant_joined(_participant_event())

    sessions.finalize = AsyncMock(return_value=False)
    with pytest.raises(PersistenceUnavailable):
        await dispatcher.handle_room_finished(_room_finished())

    sessions.finalize = AsyncMock(return_value=True)
    await dispatcher.handle_room_finished(_room_finished())

    await dispatcher.handle_participant_joined(_participant_event())
    assert len(dispatcher.active_calls()) == 1


async def test_a_completion_task_is_tracked_then_released() -> None:
    """The strong reference must exist while the handler runs and go away after."""

    completions: list = []

    class ObservableHandle:
        def __init__(self) -> None:
            self.cancelled = False

        async def cancel(self) -> None:
            self.cancelled = True

        def observe_completion(self, callback) -> None:
            completions.append(callback)

    dispatcher, sessions, launch, hangup = _dispatcher()
    launch.return_value = ObservableHandle()
    await dispatcher.handle_participant_joined(_participant_event())

    assert dispatcher._completions == set()  # noqa: SLF001
    completions[0](None)
    assert len(dispatcher._completions) == 1  # noqa: SLF001
    tracked = next(iter(dispatcher._completions))  # noqa: SLF001
    await tracked
    await asyncio.sleep(0)  # let the done-callback run and release the reference

    assert dispatcher._completions == set()  # noqa: SLF001
    hangup.assert_awaited_once()
    sessions.finalize.assert_awaited_once()
    assert dispatcher.active_calls() == []

    # The callback cannot act twice: the room is already released.
    completions[0](None)
    second = next(iter(dispatcher._completions))  # noqa: SLF001
    await second
    await asyncio.sleep(0)
    sessions.finalize.assert_awaited_once()
    hangup.assert_awaited_once()
    assert dispatcher._completions == set()  # noqa: SLF001


def test_nothing_in_production_mints_a_second_room_participant() -> None:
    """A canary for the one assumption `on_participant_left` rests on.

    `oron_agent.bot.on_participant_left` ends the session when ANY remote
    participant leaves; it does not look at which one. That is correct only
    while every room holds exactly one remote participant — the SIP leg. Two
    methods here can mint a token for a second one, and today neither has a
    production caller, so the hazard is unreachable.

    If this fails, someone has wired one of them up. Do not silence it: give
    `on_participant_left` the departing identity and end the call only for the
    participant whose departure actually ends it (the SIP leg, or the browser
    console on a BROWSER call).
    """

    root = Path(__file__).resolve().parents[4]
    definitions = root / "packages" / "py" / "oron-dispatcher" / "src"
    callers: list[str] = []
    for area in ("packages/py", "services/py", "apps", "scripts"):
        for source in (root / area).rglob("*.py"):
            parts = set(source.parts)
            if parts & {"tests", "__pycache__", ".venv", "node_modules"}:
                continue
            if source.is_relative_to(definitions):
                continue
            text = source.read_text(encoding="utf-8")
            if ".observer_token(" in text or ".start_browser_call(" in text:
                callers.append(str(source.relative_to(root)))

    assert callers == []


async def test_a_failed_agent_startup_keeps_its_failed_write_retryable() -> None:
    """Launch failed while the status write also failed: the owed FAILED must
    survive instead of vanishing into a stranded `started` row, because the
    hung-up room's room_finished delivery is this write's retry path."""

    dispatcher, sessions, launch, hangup = _dispatcher()
    launch.side_effect = RuntimeError("pipeline construction refused")
    sessions.finalize = AsyncMock(return_value=False)

    with pytest.raises(PersistenceUnavailable):
        await dispatcher.handle_participant_joined(_participant_event())

    assert hangup.await_count == 1  # the inbound leg is closed either way
    owed = dispatcher._unfinalized  # noqa: SLF001 — the durable-intent record
    assert [status for _context, status in owed.values()] == [SessionStatus.FAILED]

    sessions.finalize = AsyncMock(return_value=True)
    await dispatcher.handle_room_finished(_room_finished())
    sessions.finalize.assert_awaited_once()
    assert sessions.finalize.await_args.kwargs["status"] is SessionStatus.FAILED
    assert dispatcher.active_calls() == []


async def test_participant_redelivery_after_failed_startup_cannot_dial_or_relabel() -> None:
    """The full inbound repair chain: startup refused and its FAILED write
    failed too, so the row is `started` with no runtime. A redelivered
    participant_joined must not relaunch or re-dial (begin already consumed the
    admission key), and the room's eventual room_finished must still settle the
    owed FAILED rather than an ENDED invented by the generic event."""

    dispatcher, sessions, launch, hangup = _dispatcher()
    launch.side_effect = RuntimeError("pipeline construction refused")
    sessions.finalize = AsyncMock(return_value=False)

    with pytest.raises(PersistenceUnavailable):
        await dispatcher.handle_participant_joined(_participant_event())

    launch.side_effect = None
    sessions.begin = AsyncMock(return_value=False)  # admission key already used
    await dispatcher.handle_participant_joined(_participant_event())

    launch.assert_awaited_once()  # only the original attempt, never the retry
    assert dispatcher.active_calls() == []

    sessions.finalize = AsyncMock(return_value=True)
    await dispatcher.handle_room_finished(_room_finished())
    assert sessions.finalize.await_args.kwargs["status"] is SessionStatus.FAILED


async def test_owed_writes_survive_repeated_failed_redeliveries_without_changing_status() -> None:
    """A long outage makes LiveKit deliver room_finished several times. Each
    failed delivery keeps the record (503 → ledger 'failed' → redelivery) with
    the first-observed status, and the delivery that finally lands settles it —
    no re-derivation from the later generic event, no duplicate settlement."""

    dispatcher, sessions, _launch, _hangup = _dispatcher()
    await dispatcher.handle_participant_joined(_participant_event())

    for _ in range(3):  # 1s, 10s, and however long the outage lasts
        sessions.finalize = AsyncMock(return_value=False)
        with pytest.raises(PersistenceUnavailable):
            await dispatcher.handle_room_finished(_room_finished())
        owed = dispatcher._unfinalized  # noqa: SLF001 — still owed after each failure
        assert [status for _context, status in owed.values()] == [SessionStatus.ENDED]

    sessions.finalize = AsyncMock(return_value=True)
    await dispatcher.handle_room_finished(_room_finished())
    assert sessions.finalize.await_args.kwargs["status"] is SessionStatus.ENDED

    # Settled: a further duplicate delivery writes nothing at all.
    sessions.finalize = AsyncMock(return_value=True)
    await dispatcher.handle_room_finished(_room_finished())
    sessions.finalize.assert_not_awaited()
