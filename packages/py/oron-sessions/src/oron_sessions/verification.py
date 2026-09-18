"""Deciding whether a call's artifacts are actually usable.

A stored URI is not a playable recording and an object row is not a transcript.
The session row gets its `recording_uri`/`transcript_uri` written on the failed
path too, precisely so that absence is discovered from the object rather than
inferred from a null column — which means something has to go and look.

This module is that look. It reads the bytes through the same
`read_artifact` abstraction the authenticated playback endpoint uses, so a
`ready` verdict means the operator pressing play will get those exact bytes,
and parses them far enough to tell an empty WAV header from a conversation and
a truncated transcript from a complete one.

Deliberately dependency-free: `wave` ships with Python and the transcript is a
line-per-turn text file this repository writes itself. Pulling in a decoder to
learn a duration that the RIFF header already states would add a native
dependency to every deployment for nothing.
"""

from __future__ import annotations

import io
import wave
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field

from oron_sessions.artifacts import ArtifactUnavailable, read_artifact

# The agent writes 16-bit PCM WAV (see `oron_agent.storage.save_audio_file`), so
# a file that is not that is a file we should not claim is a call recording.
EXPECTED_SAMPLE_WIDTH_BYTES = 2
# A WAV with a header and no frames is the classic "the upload landed but the
# call never produced audio" case. One second is the shortest plausible turn.
MINIMUM_PLAUSIBLE_SECONDS = 1.0
# A complete conversation that somehow exceeds this is not something to load
# into memory to inspect; the bound protects the verifier, not the caller.
MAXIMUM_RECORDING_BYTES = 256 * 1024 * 1024
MAXIMUM_TRANSCRIPT_BYTES = 8 * 1024 * 1024


class RecordingState(StrEnum):
    """Honest readiness, matching `support.ticket_call_attempts.recording_state`."""

    READY = "ready"
    PARTIAL = "partial"
    UNAVAILABLE = "unavailable"
    FAILED = "failed"


class TranscriptState(StrEnum):
    VALID = "valid"
    PARTIAL = "partial"
    EMPTY = "empty"
    MISSING = "missing"
    FAILED = "failed"


class RecordingVerification(BaseModel):
    state: RecordingState
    # A fixed vocabulary, never an exception string: this crosses a service
    # boundary and lands in an operator-visible column.
    detail: Literal[
        "verified",
        "no_uri",
        "bytes_unavailable",
        "empty_file",
        "not_wav",
        "unexpected_sample_format",
        "header_only",
        "short_but_present",
        "too_large",
    ]
    byte_size: int | None = None
    duration_seconds: float | None = None
    sample_rate: int | None = None
    channels: int | None = None
    content_type: str | None = None
    checksum: str | None = None
    storage_backend: Literal["local", "gcs"] | None = None
    storage_key: str | None = None


class TranscriptVerification(BaseModel):
    state: TranscriptState
    detail: Literal[
        "verified",
        "no_uri",
        "bytes_unavailable",
        "empty_file",
        "no_turns",
        "unparsable_tail",
        "not_utf8",
        "too_large",
    ]
    byte_size: int | None = None
    turn_count: int = 0
    interrupted_turn_count: int = 0
    content_type: str | None = None
    checksum: str | None = None
    storage_backend: Literal["local", "gcs"] | None = None
    storage_key: str | None = None


class TranscriptTurn(BaseModel):
    """One parsed turn, numbered from 1 so an analysis can cite it."""

    index: int
    role: str
    text: str
    interrupted: bool = False
    timestamp: str | None = None


class ArtifactVerification(BaseModel):
    """Both artifacts, verified independently.

    Independent on purpose: a transcript can land before its recording and a
    failed call can leave audio with no turns. Reporting one state for the pair
    would force the caller to guess which half it is looking at.
    """

    session_id: str
    recording: RecordingVerification
    transcript: TranscriptVerification
    verified_at: str = Field(description="RFC 3339 instant the bytes were read")


def _storage_reference(uri: str) -> tuple[Literal["local", "gcs"], str] | None:
    """Split an artifact URI into the object registry's backend and key.

    `objects.object_metadata` is keyed by `(storage_backend, storage_key)`, so a
    verified artifact can be registered there exactly once however many times
    verification runs.
    """
    from urllib.parse import unquote, urlparse

    parsed = urlparse(uri)
    if parsed.scheme == "gs" and parsed.netloc:
        key = unquote(parsed.path).lstrip("/")
        return ("gcs", f"{parsed.netloc}/{key}") if key else None
    if parsed.scheme == "file":
        key = unquote(parsed.path).lstrip("/")
        return ("local", key) if key else None
    return None


def _checksum(payload: bytes) -> str:
    import hashlib

    return hashlib.sha256(payload).hexdigest()


def inspect_recording(payload: bytes) -> tuple[RecordingState, str, dict[str, object]]:
    """Classify recording bytes without claiming more than the header proves."""
    if not payload:
        return (RecordingState.UNAVAILABLE, "empty_file", {})
    try:
        with wave.open(io.BytesIO(payload), "rb") as audio:
            channels = audio.getnchannels()
            sample_rate = audio.getframerate()
            sample_width = audio.getsampwidth()
            frames = audio.getnframes()
    except wave.Error, EOFError:
        # A truncated upload still starts with RIFF; `wave` refuses it, and so
        # do we. Calling it `failed` rather than `unavailable` keeps "the bytes
        # are there but unusable" distinguishable from "there are no bytes".
        return (RecordingState.FAILED, "not_wav", {})
    if sample_width != EXPECTED_SAMPLE_WIDTH_BYTES or sample_rate <= 0 or channels <= 0:
        return (
            RecordingState.FAILED,
            "unexpected_sample_format",
            {"sample_rate": sample_rate, "channels": channels},
        )
    duration = frames / sample_rate
    facts: dict[str, object] = {
        "sample_rate": sample_rate,
        "channels": channels,
        "duration_seconds": round(duration, 3),
    }
    if frames == 0:
        # Header-only: the container is valid and there is no call in it.
        return (RecordingState.UNAVAILABLE, "header_only", facts)
    if duration < MINIMUM_PLAUSIBLE_SECONDS:
        # A real fragment, and not a complete call. A dropped call legitimately
        # produces one; labelling it `ready` would let the console offer it as
        # the recording of a conversation that never happened.
        return (RecordingState.PARTIAL, "short_but_present", facts)
    return (RecordingState.READY, "verified", facts)


def parse_transcript(payload: bytes) -> tuple[TranscriptState, str, dict[str, object]]:
    """Read the canonical line-per-turn transcript this repository writes.

    The format is `[timestamp] role[ [interrupted]]: content`, appended during
    the call and rewritten in event-time order at the end. A crash between those
    two points leaves a valid journal, so a file whose last line has no
    separator is reported as `partial` rather than thrown away.
    """
    if not payload:
        return (TranscriptState.EMPTY, "empty_file", {"turn_count": 0})
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        return (TranscriptState.FAILED, "not_utf8", {"turn_count": 0})
    lines = [line for line in text.splitlines() if line.strip()]
    turns = 0
    interrupted = 0
    unparsable = 0
    for line in lines:
        body = line
        if body.startswith("["):
            closing = body.find("] ")
            if closing == -1:
                unparsable += 1
                continue
            body = body[closing + 2 :]
        separator = body.find(": ")
        if separator <= 0:
            unparsable += 1
            continue
        role = body[:separator]
        if role.endswith(" [interrupted]"):
            interrupted += 1
        turns += 1
    facts: dict[str, object] = {
        "turn_count": turns,
        "interrupted_turn_count": interrupted,
    }
    if turns == 0:
        return (TranscriptState.EMPTY, "no_turns", facts)
    if unparsable > 0:
        return (TranscriptState.PARTIAL, "unparsable_tail", facts)
    return (TranscriptState.VALID, "verified", facts)


def transcript_turns(payload: bytes, *, limit: int = 400) -> list[TranscriptTurn]:
    """Parse the transcript into citable turns through the same reader.

    Numbering follows the file, not the surviving subset, so a turn index means
    the same thing to whoever reads the transcript next. Unparsable lines are
    skipped rather than renumbering everything after them.
    """
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        return []
    turns: list[TranscriptTurn] = []
    index = 0
    for line in text.splitlines():
        if not line.strip():
            continue
        body = line
        stamp: str | None = None
        if body.startswith("["):
            closing = body.find("] ")
            if closing == -1:
                continue
            stamp = body[1:closing]
            body = body[closing + 2 :]
        separator = body.find(": ")
        if separator <= 0:
            continue
        role = body[:separator]
        interrupted = role.endswith(" [interrupted]")
        if interrupted:
            role = role[: -len(" [interrupted]")]
        index += 1
        if len(turns) >= limit:
            continue
        turns.append(
            TranscriptTurn(
                index=index,
                role=role[:40],
                text=body[separator + 2 :][:2000],
                interrupted=interrupted,
                timestamp=stamp[:64] if stamp else None,
            )
        )
    return turns


async def verify_recording(uri: str | None) -> RecordingVerification:
    """Fetch and classify the recording the session row points at."""
    if not uri:
        return RecordingVerification(state=RecordingState.UNAVAILABLE, detail="no_uri")
    reference = _storage_reference(uri)
    try:
        payload = await read_artifact(uri)
    except ArtifactUnavailable:
        # The row is fine and the bytes are not there — an upload that never
        # landed, or an object removed by retention.
        return RecordingVerification(state=RecordingState.UNAVAILABLE, detail="bytes_unavailable")
    if len(payload) > MAXIMUM_RECORDING_BYTES:
        return RecordingVerification(
            state=RecordingState.FAILED, detail="too_large", byte_size=len(payload)
        )
    state, detail, facts = inspect_recording(payload)
    playable = state in {RecordingState.READY, RecordingState.PARTIAL}
    return RecordingVerification(
        state=state,
        detail=detail,  # type: ignore[arg-type]
        byte_size=len(payload),
        duration_seconds=facts.get("duration_seconds"),  # type: ignore[arg-type]
        sample_rate=facts.get("sample_rate"),  # type: ignore[arg-type]
        channels=facts.get("channels"),  # type: ignore[arg-type]
        content_type="audio/wav" if playable else None,
        checksum=_checksum(payload) if playable else None,
        storage_backend=reference[0] if playable and reference else None,
        storage_key=reference[1] if playable and reference else None,
    )


async def verify_transcript(uri: str | None) -> TranscriptVerification:
    """Fetch and parse the transcript through the canonical reader."""
    if not uri:
        return TranscriptVerification(state=TranscriptState.MISSING, detail="no_uri")
    reference = _storage_reference(uri)
    try:
        payload = await read_artifact(uri)
    except ArtifactUnavailable:
        return TranscriptVerification(state=TranscriptState.MISSING, detail="bytes_unavailable")
    if len(payload) > MAXIMUM_TRANSCRIPT_BYTES:
        return TranscriptVerification(
            state=TranscriptState.FAILED, detail="too_large", byte_size=len(payload)
        )
    state, detail, facts = parse_transcript(payload)
    usable = state in {TranscriptState.VALID, TranscriptState.PARTIAL}
    return TranscriptVerification(
        state=state,
        detail=detail,  # type: ignore[arg-type]
        byte_size=len(payload),
        turn_count=int(facts.get("turn_count", 0)),  # type: ignore[arg-type]
        interrupted_turn_count=int(facts.get("interrupted_turn_count", 0)),  # type: ignore[arg-type]
        content_type="text/plain; charset=utf-8" if usable else None,
        checksum=_checksum(payload) if usable else None,
        storage_backend=reference[0] if usable and reference else None,
        storage_key=reference[1] if usable and reference else None,
    )
