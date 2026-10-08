from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from dispatcher_runtime import announcements


@pytest.mark.parametrize("kind", ["busy", "goodbye", "failure", "unavailable", "recovery"])
def test_fixed_audio_is_pcm16_mono_bounded_and_non_silent(kind):
    pcm = announcements.announcement_pcm(kind)
    assert len(pcm) % 2 == 0
    assert 16000 * 2 < len(pcm) <= 8 * 16000 * 2
    assert any(pcm)


def test_unknown_announcement_cannot_choose_a_file():
    with pytest.raises(ValueError):
        announcements.announcement_pcm("../../private")


async def test_playback_preserves_framing_waits_for_subscription_and_cleans_up(monkeypatch):
    order = []
    chunks = []

    async def subscribed():
        order.append("subscribed")

    async def capture(frame):
        assert order == ["subscribed"]
        assert frame.sample_rate == 16000 and frame.num_channels == 1
        assert 0 < frame.samples_per_channel <= 320
        chunks.append(bytes(frame.data))

    publication = SimpleNamespace(wait_for_subscription=subscribed)
    room = SimpleNamespace(
        connect=AsyncMock(),
        disconnect=AsyncMock(),
        local_participant=SimpleNamespace(publish_track=AsyncMock(return_value=publication)),
    )
    source = SimpleNamespace(
        capture_frame=capture, wait_for_playout=AsyncMock(), aclose=AsyncMock()
    )
    monkeypatch.setattr(announcements.rtc, "Room", Mock(return_value=room))
    monkeypatch.setattr(announcements.rtc, "AudioSource", Mock(return_value=source))
    monkeypatch.setattr(
        announcements.rtc.LocalAudioTrack, "create_audio_track", Mock(return_value=object())
    )
    mint = Mock(return_value="fictional-room-scoped-token")
    adapter = announcements.RoomAnnouncements(url="ws://fictional.invalid", mint_token=mint)
    await adapter.play("fictional-room", "busy")
    assert b"".join(chunks) == announcements.announcement_pcm("busy")
    source.wait_for_playout.assert_awaited_once()
    room.disconnect.assert_awaited_once()
    source.aclose.assert_awaited_once()
    mint.assert_called_once_with("fictional-room", "oron-busy")
    assert adapter._slots._value == 3


async def test_connect_failure_cleans_up_and_releases_slot(monkeypatch):
    room = SimpleNamespace(
        connect=AsyncMock(side_effect=RuntimeError("fictional failure")), disconnect=AsyncMock()
    )
    source = SimpleNamespace(aclose=AsyncMock())
    monkeypatch.setattr(announcements.rtc, "Room", Mock(return_value=room))
    monkeypatch.setattr(announcements.rtc, "AudioSource", Mock(return_value=source))
    adapter = announcements.RoomAnnouncements(
        url="ws://fictional.invalid", mint_token=lambda *_: "test"
    )
    with pytest.raises(RuntimeError):
        await adapter.play("fictional-room", "goodbye")
    room.disconnect.assert_awaited_once()
    source.aclose.assert_awaited_once()
    assert adapter._slots._value == 3


@pytest.mark.parametrize("error", [FileNotFoundError(), ValueError("corrupt")])
async def test_bad_asset_does_not_connect_or_hold_capacity(monkeypatch, error):
    monkeypatch.setattr(announcements, "announcement_pcm", Mock(side_effect=error))
    connect = Mock()
    monkeypatch.setattr(announcements.rtc, "Room", connect)
    adapter = announcements.RoomAnnouncements(url="ws://fictional.invalid", mint_token=Mock())
    await adapter.play("fictional-room", "failure")
    connect.assert_not_called()
    assert adapter._slots._value == 3
