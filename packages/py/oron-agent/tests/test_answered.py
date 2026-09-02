"""Outbound must wait for pick-up, not for the SIP participant to join.

The live failure on 2026-07-27: the bot spoke its opening line 5.1s before
`Outbound SIP call established`, the callee answered to silence and said "הלו?",
and the flow — already past its opening node — improvised off-script and out of
persona.
"""

import asyncio
from types import SimpleNamespace

from oron_agent.answered import wait_until_answered


def _transport(*statuses: str):
    participants = {
        f"p{i}": SimpleNamespace(attributes={"sip.callStatus": s}) for i, s in enumerate(statuses)
    }
    room = SimpleNamespace(remote_participants=participants)
    return SimpleNamespace(_client=SimpleNamespace(room=room))


async def test_returns_immediately_once_answered():
    assert await wait_until_answered(_transport("active"), timeout_secs=5) is True


async def test_a_ringing_participant_is_not_answered():
    """The exact production state: the participant is in the room, the phone is
    still ringing, and greeting now is what loses the opener."""
    ringing = _transport("dialing")

    assert await wait_until_answered(ringing, timeout_secs=0.3, poll_secs=0.05) is False


async def test_it_unblocks_when_the_callee_picks_up_mid_wait():
    transport = _transport("dialing")

    async def answer_after_a_moment():
        await asyncio.sleep(0.1)
        transport._client.room.remote_participants["p0"].attributes["sip.callStatus"] = "active"

    _, answered = await asyncio.gather(
        answer_after_a_moment(),
        wait_until_answered(transport, timeout_secs=5, poll_secs=0.02),
    )
    assert answered is True


async def test_a_carrier_that_never_reports_status_still_gets_a_call():
    """Fail open. A bot that greets early makes a bad call; a bot that never
    greets makes a dead one, and silence would be the default for any carrier
    that does not publish the attribute."""
    no_attrs = SimpleNamespace(
        _client=SimpleNamespace(
            room=SimpleNamespace(remote_participants={"p0": SimpleNamespace(attributes={})})
        )
    )

    assert await wait_until_answered(no_attrs, timeout_secs=0.2, poll_secs=0.05) is False


async def test_introspection_failure_never_ends_the_call():
    """Reaching through `_client` is private API — if pipecat moves it, the call
    must degrade to greeting early, not raise inside the join handler."""
    broken = SimpleNamespace()

    assert await wait_until_answered(broken, timeout_secs=0.2, poll_secs=0.05) is False
