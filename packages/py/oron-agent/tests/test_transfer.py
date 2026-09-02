"""The transfer action.

Every test here beyond the first is the same claim from a different angle: a
failed transfer must never be worse than no transfer. A raise escaping into
pipecat's action executor becomes ActionError -> FlowError and ends the call,
so the caller loses the conversation as well as the handover.
"""

from unittest.mock import AsyncMock, MagicMock

from livekit.protocol import models
from oron_agent.transfer import make_transfer_action

ROOM = "call-1"
DESK = "+14155552671"


def _api(*kinds: int) -> MagicMock:
    """A LiveKitAPI double whose room holds one participant per kind given."""
    lkapi = MagicMock()
    lkapi.room.list_participants = AsyncMock(
        return_value=MagicMock(
            participants=[
                models.ParticipantInfo(identity=f"p{i}", kind=kind) for i, kind in enumerate(kinds)
            ]
        )
    )
    lkapi.sip.transfer_sip_participant = AsyncMock()
    lkapi.__aenter__ = AsyncMock(return_value=lkapi)
    lkapi.__aexit__ = AsyncMock(return_value=None)
    return lkapi


def _action(lkapi: MagicMock):
    return make_transfer_action(
        room=ROOM, url="x", api_key="k", api_secret="s", api_factory=lambda *a: lkapi
    )


async def test_it_refers_the_sip_leg_and_ignores_the_agent():
    lkapi = _api(models.ParticipantInfo.Kind.AGENT, models.ParticipantInfo.Kind.SIP)
    await _action(lkapi)({"type": "transfer", "to": DESK}, None)

    req = lkapi.sip.transfer_sip_participant.await_args.args[0]
    assert req.participant_identity == "p1"
    assert req.room_name == ROOM
    assert req.transfer_to == f"tel:{DESK}"


async def test_no_sip_participant_is_not_an_error():
    """A browser test call, or a caller who hung up during the closing line."""
    lkapi = _api(models.ParticipantInfo.Kind.STANDARD)
    await _action(lkapi)({"type": "transfer", "to": DESK}, None)
    lkapi.sip.transfer_sip_participant.assert_not_awaited()


async def test_a_refused_refer_does_not_propagate():
    lkapi = _api(models.ParticipantInfo.Kind.SIP)
    lkapi.sip.transfer_sip_participant.side_effect = RuntimeError("403 Forbidden")
    await _action(lkapi)({"type": "transfer", "to": DESK}, None)


async def test_a_client_that_cannot_be_built_does_not_propagate():
    action = make_transfer_action(
        room=ROOM,
        url="x",
        api_key="k",
        api_secret="s",
        api_factory=MagicMock(side_effect=RuntimeError("bad url")),
    )
    await action({"type": "transfer", "to": DESK}, None)


async def test_an_action_without_a_target_does_not_propagate():
    """`to` is required by the component and validated by ActionSpec, so this is
    unreachable through a published flow — and a KeyError here would still end a
    live call, which is too high a price for an assumption about the binder."""
    lkapi = _api(models.ParticipantInfo.Kind.SIP)
    await _action(lkapi)({"type": "transfer"}, None)
    lkapi.sip.transfer_sip_participant.assert_not_awaited()
