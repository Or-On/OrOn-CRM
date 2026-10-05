"""Bounded prerecorded lifecycle audio; no model or synthesis requests."""

from __future__ import annotations

import asyncio
import io
import wave
from collections.abc import Callable
from importlib.resources import files
from typing import Literal

from livekit import rtc

Announcement = Literal["busy", "goodbye", "failure", "unavailable", "recovery"]


def announcement_pcm(kind: Announcement) -> bytes:
    if kind not in ("busy", "goodbye", "failure", "unavailable", "recovery"):
        raise ValueError("unknown voice announcement")
    data = files("oron_dispatcher").joinpath("audio", f"{kind}-he.wav").read_bytes()
    with wave.open(io.BytesIO(data)) as audio:
        if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) != (16000, 1, 2):
            raise ValueError("announcement must be mono PCM16 at16kHz")
        if not 0 < audio.getnframes() <= 8 * 16000:
            raise ValueError("announcement duration exceeds bounded playback")
        return audio.readframes(audio.getnframes())


class RoomAnnouncements:
    """Publish one fixed audio track and wait for playout before disconnecting."""

    def __init__(self, *, url: str, mint_token: Callable[[str, str], str]) -> None:
        self._url = url
        self._mint = mint_token
        self._slots = asyncio.Semaphore(3)

    async def play(self, room_name: str, kind: Announcement) -> None:
        pcm = announcement_pcm(kind)
        await asyncio.wait_for(self._slots.acquire(), timeout=2)
        room = None
        source = None
        try:
            room = rtc.Room()
            source = rtc.AudioSource(16000, 1, queue_size_ms=1000)
            async with asyncio.timeout(15):
                await room.connect(self._url, self._mint(room_name, f"oron-{kind}"))
                track = rtc.LocalAudioTrack.create_audio_track(f"oron-{kind}", source)
                publication = await room.local_participant.publish_track(
                    track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
                )
                await asyncio.wait_for(publication.wait_for_subscription(), timeout=3)
                # 20ms frames; preserve the final partial frame exactly.
                for offset in range(0, len(pcm), 640):
                    chunk = pcm[offset : offset + 640]
                    await source.capture_frame(rtc.AudioFrame(chunk, 16000, 1, len(chunk) // 2))
                await source.wait_for_playout()
        finally:
            try:
                await asyncio.wait_for(
                    asyncio.gather(
                        *(
                            operation
                            for operation in (
                                room.disconnect() if room is not None else None,
                                source.aclose() if source is not None else None,
                            )
                            if operation is not None
                        ),
                        return_exceptions=True,
                    ),
                    timeout=3,
                )
            finally:
                self._slots.release()
