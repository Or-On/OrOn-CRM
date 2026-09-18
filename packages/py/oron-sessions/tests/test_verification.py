"""A stored URI is not a playable recording, and these tests hold that line.

Every case here is one of the ways an artifact can exist and still be useless:
the upload that never landed, the header with no frames, the truncated copy, the
transcript that was journalled but never finalised. Each has a distinct verdict
because the ticket UI, the summary step and the operator all need to tell them
apart.
"""

from __future__ import annotations

import io
import wave
from pathlib import Path

import pytest
from oron_sessions.verification import (
    RecordingState,
    TranscriptState,
    inspect_recording,
    parse_transcript,
    transcript_turns,
    verify_recording,
    verify_transcript,
)


def _wav(seconds: float, *, channels: int = 1, rate: int = 16_000, width: int = 2) -> bytes:
    frames = int(seconds * rate)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(width)
        audio.setframerate(rate)
        audio.writeframes(b"\x00" * frames * channels * width)
    return buffer.getvalue()


def test_a_complete_call_is_ready_with_its_duration() -> None:
    state, detail, facts = inspect_recording(_wav(12.5))

    assert state is RecordingState.READY
    assert detail == "verified"
    assert facts["duration_seconds"] == pytest.approx(12.5)
    assert facts["sample_rate"] == 16_000


def test_a_header_with_no_frames_is_unavailable_not_ready() -> None:
    state, detail, _ = inspect_recording(_wav(0))

    # The container is valid and there is no call in it. Calling this `ready`
    # is exactly how a console ends up offering silence as a conversation.
    assert state is RecordingState.UNAVAILABLE
    assert detail == "header_only"


def test_a_fragment_is_partial_rather_than_a_complete_call() -> None:
    state, detail, facts = inspect_recording(_wav(0.4))

    assert state is RecordingState.PARTIAL
    assert detail == "short_but_present"
    assert facts["duration_seconds"] == pytest.approx(0.4)


def test_a_truncated_upload_is_failed_not_missing() -> None:
    state, detail, _ = inspect_recording(_wav(3)[:20])

    assert state is RecordingState.FAILED
    assert detail == "not_wav"


def test_an_unexpected_sample_format_is_not_claimed_as_a_call_recording() -> None:
    state, detail, _ = inspect_recording(_wav(3, width=1))

    assert state is RecordingState.FAILED
    assert detail == "unexpected_sample_format"


def test_empty_bytes_are_unavailable() -> None:
    state, detail, _ = inspect_recording(b"")

    assert state is RecordingState.UNAVAILABLE
    assert detail == "empty_file"


TRANSCRIPT = (
    "[2026-09-19T09:00:00] user: שלום, האינטרנט נופל כל ערב\n"
    "[2026-09-19T09:00:05] assistant: אפשר לנסות לאתחל את הנתב?\n"
    "[2026-09-19T09:00:40] user [interrupted]: אתחלתי, עכשיו זה עובד\n"
)


def test_a_complete_transcript_reports_its_turns() -> None:
    state, detail, facts = parse_transcript(TRANSCRIPT.encode())

    assert state is TranscriptState.VALID
    assert detail == "verified"
    assert facts["turn_count"] == 3
    assert facts["interrupted_turn_count"] == 1


def test_a_journal_cut_mid_line_is_partial_rather_than_discarded() -> None:
    payload = (TRANSCRIPT + "[2026-09-19T09:01:00 user: and then\n").encode()

    state, detail, facts = parse_transcript(payload)

    # A crash between the append-as-you-go journal and the final ordered pass
    # leaves this. The three complete turns are still evidence.
    assert state is TranscriptState.PARTIAL
    assert detail == "unparsable_tail"
    assert facts["turn_count"] == 3


def test_a_transcript_with_no_turns_is_empty_not_valid() -> None:
    blank, blank_detail, _ = parse_transcript(b"\n\n")
    nothing, nothing_detail, _ = parse_transcript(b"")

    # Both are empty, and the detail keeps "a file was written with nothing in
    # it" apart from "no bytes at all" for whoever has to debug the upload.
    assert blank is TranscriptState.EMPTY
    assert blank_detail == "no_turns"
    assert nothing is TranscriptState.EMPTY
    assert nothing_detail == "empty_file"


def test_turns_are_numbered_by_the_file_so_a_citation_keeps_its_meaning() -> None:
    turns = transcript_turns(TRANSCRIPT.encode())

    assert [turn.index for turn in turns] == [1, 2, 3]
    assert turns[2].role == "user"
    assert turns[2].interrupted is True
    assert turns[0].text.startswith("שלום")


def test_non_utf8_bytes_fail_rather_than_producing_mojibake_turns() -> None:
    state, detail, _ = parse_transcript(b"\xff\xfe\x00bad")

    assert state is TranscriptState.FAILED
    assert detail == "not_utf8"
    assert transcript_turns(b"\xff\xfe\x00bad") == []


async def test_a_stored_uri_with_nothing_behind_it_is_unavailable(tmp_path: Path) -> None:
    missing = (tmp_path / "conversations" / "x" / "merged_audio.wav").as_uri()

    verified = await verify_recording(missing)

    assert verified.state is RecordingState.UNAVAILABLE
    assert verified.detail == "bytes_unavailable"
    # Nothing is registered for an artifact we could not read.
    assert verified.checksum is None
    assert verified.storage_key is None


async def test_a_missing_uri_is_distinguished_from_missing_bytes() -> None:
    assert (await verify_recording(None)).detail == "no_uri"
    assert (await verify_transcript(None)).state is TranscriptState.MISSING


async def test_a_verified_recording_carries_what_the_registry_needs(tmp_path: Path) -> None:
    path = tmp_path / "merged_audio.wav"
    path.write_bytes(_wav(6))

    verified = await verify_recording(path.as_uri())

    assert verified.state is RecordingState.READY
    assert verified.byte_size == path.stat().st_size
    assert verified.content_type == "audio/wav"
    assert verified.storage_backend == "local"
    assert verified.checksum is not None and len(verified.checksum) == 64
    assert verified.storage_key is not None and verified.storage_key.endswith("merged_audio.wav")


async def test_a_verified_transcript_carries_its_turn_count(tmp_path: Path) -> None:
    path = tmp_path / "transcript.txt"
    path.write_text(TRANSCRIPT, encoding="utf-8")

    verified = await verify_transcript(path.as_uri())

    assert verified.state is TranscriptState.VALID
    assert verified.turn_count == 3
    assert verified.content_type == "text/plain; charset=utf-8"
