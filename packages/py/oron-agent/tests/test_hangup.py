"""Hanging up is what ends a call the bot finished itself.

`end_conversation` stops the pipeline and nothing else. Measured live on
2026-07-27: the bot said "יום טוב" at 16:20:06 and the SIP leg stayed up until
16:20:43 — 37 seconds of dead air, because LiveKit was left to reap the empty
room on its own timer.
"""

from unittest.mock import AsyncMock, Mock

import pytest
from oron_agent.hangup import hangup_room


@pytest.fixture
def lkapi(monkeypatch):
    fake = Mock()
    fake.room.delete_room = AsyncMock()
    fake.aclose = AsyncMock()
    monkeypatch.setattr("oron_agent.hangup.api.LiveKitAPI", Mock(return_value=fake))
    return fake


async def test_it_deletes_the_room(lkapi):
    """Deleting the room is the hangup — it drops every leg, including SIP."""
    await hangup_room("call-abc", url="ws://lk", api_key="k", api_secret="s")

    assert lkapi.room.delete_room.await_args.args[0].room == "call-abc"


async def test_the_client_is_closed_even_when_the_delete_fails(lkapi):
    lkapi.room.delete_room.side_effect = RuntimeError("livekit unreachable")

    await hangup_room("call-abc", url="ws://lk", api_key="k", api_secret="s")

    lkapi.aclose.assert_awaited_once()


async def test_a_failed_hangup_never_raises(lkapi):
    """This runs during teardown, immediately before the row is finalized. An
    exception here would trade a stuck call for a call with no record at all."""
    lkapi.room.delete_room.side_effect = RuntimeError("livekit unreachable")

    await hangup_room("call-abc", url="ws://lk", api_key="k", api_secret="s")
