"""Bounded, content-free timing evidence from the running Pipecat pipeline."""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from pipecat.frames.frames import (
    AggregatedTextFrame,
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMTextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

_DURATION_STAGES = {
    "speech_end_to_accepted_ms": ("speech_end", "recognition_finalized"),
    "accepted_to_model_request_ms": ("recognition_finalized", "model_request"),
    "model_first_token_ms": ("model_request", "model_first_token"),
    "model_to_generated_ms": ("model_request", "generated"),
    "validation_ms": ("generated", "validated"),
    "validated_to_synthesis_ms": ("validated", "first_synthesized_audio"),
    "synthesis_to_transport_ms": ("first_synthesized_audio", "first_transport_submission"),
    "accepted_to_transport_signal_ms": ("recognition_finalized", "transport_speaking_signal"),
}


@dataclass
class _Turn:
    index: int
    timestamps: dict[str, int] = field(default_factory=dict)
    generation: int | None = None
    interrupted: bool = False
    transport_stopped: bool = False

    def durations(self) -> dict[str, float | None]:
        values: dict[str, float | None] = {}
        for name, (start, end) in _DURATION_STAGES.items():
            start_ns, end_ns = self.timestamps.get(start), self.timestamps.get(end)
            values[name] = (
                round((end_ns - start_ns) / 1_000_000, 3)
                if start_ns is not None and end_ns is not None and end_ns >= start_ns
                else None
            )
        return values


class VoiceQualityObserver(BaseObserver):
    """Capture stage observations; a transport signal is not a playback receipt.

    Frames are correlated by the current serialized Pipecat request and TTS
    context where supplied. Missing stages stay unknown. No transcript text,
    tool payload, user IDs, source document IDs or credentials are retained.
    """

    def __init__(
        self,
        *,
        llm: FrameProcessor,
        tts: FrameProcessor,
        transport_output: FrameProcessor,
        max_turns: int = 128,
    ) -> None:
        super().__init__()
        if not 1 <= max_turns <= 1024:
            raise ValueError("max_turns must be between 1 and 1024")
        self._llm = llm
        self._tts = tts
        self._transport = transport_output
        self._turns: deque[_Turn] = deque(maxlen=max_turns)
        self._seen: deque[tuple[int, str]] = deque(maxlen=4096)
        self._contexts: dict[str, _Turn] = {}
        self._current: _Turn | None = None
        self._last_speech_end: int | None = None
        self._accepted_ns: int | None = None
        self._turn_count = 0
        self._stale_audio_frames = 0

    def _once(self, frame_id: int, stage: str) -> bool:
        key = (frame_id, stage)
        if key in self._seen:
            return False
        self._seen.append(key)
        return True

    def _new_turn(self, timestamp: int) -> _Turn:
        self._turn_count += 1
        turn = _Turn(self._turn_count, {"model_request": timestamp})
        if self._accepted_ns is not None:
            turn.timestamps["recognition_finalized"] = self._accepted_ns
        if self._last_speech_end is not None:
            turn.timestamps["speech_end"] = self._last_speech_end
        self._accepted_ns = None
        self._last_speech_end = None
        self._turns.append(turn)
        retained = {item.index for item in self._turns}
        self._contexts = {
            key: value for key, value in self._contexts.items() if value.index in retained
        }
        self._current = turn
        return turn

    async def on_push_frame(self, data: FramePushed) -> None:
        if data.direction is not FrameDirection.DOWNSTREAM:
            return
        frame, stamp = data.frame, data.timestamp
        if isinstance(frame, UserStoppedSpeakingFrame) and self._once(frame.id, "speech_end"):
            self._last_speech_end = stamp
            if self._current is not None and "recognition_finalized" in self._current.timestamps:
                self._current.timestamps.setdefault("speech_end", stamp)
        elif (
            isinstance(frame, TranscriptionFrame)
            and frame.metadata.get("recognition_state") == "accepted"
            and self._once(frame.id, "accepted")
        ):
            self._accepted_ns = stamp
        elif (
            isinstance(frame, LLMContextFrame)
            and data.destination is self._llm
            and self._once(frame.id, "request")
        ):
            self._new_turn(stamp)

        turn = self._current
        if turn is None:
            return
        if isinstance(frame, LLMTextFrame) and data.source is self._llm:
            turn.timestamps.setdefault("model_first_token", stamp)
        elif isinstance(frame, AggregatedTextFrame):
            generation = frame.metadata.get("voice_generation")
            if isinstance(generation, int):
                turn.generation = generation
                turn.timestamps.setdefault("generated", stamp)
            if "grounding" in frame.metadata:
                turn.timestamps.setdefault("validated", stamp)
        elif isinstance(frame, TTSAudioRawFrame):
            if frame.context_id is not None:
                turn = self._contexts.setdefault(frame.context_id, turn)
                # There can be multiple synthesis contexts in a turn. Bound the
                # map independently of the turn count under unexpected traffic.
                if len(self._contexts) > 1024:
                    del self._contexts[next(iter(self._contexts))]
            if turn.interrupted:
                if self._once(frame.id, "stale_audio"):
                    self._stale_audio_frames += 1
                return
            if data.source is self._tts:
                turn.timestamps.setdefault("first_synthesized_audio", stamp)
            if data.destination is self._transport:
                turn.timestamps.setdefault("first_transport_submission", stamp)
        elif isinstance(frame, BotStartedSpeakingFrame) and data.source is self._transport:
            turn.timestamps.setdefault("transport_speaking_signal", stamp)
        elif isinstance(frame, BotStoppedSpeakingFrame) and data.source is self._transport:
            turn.transport_stopped = True
        elif isinstance(frame, InterruptionFrame):
            turn.interrupted = True

    def snapshot(self) -> dict[str, Any]:
        """Return a JSON-safe artifact payload with only counts, timing and status."""
        turns = []
        for turn in self._turns:
            turns.append(
                {
                    "turn_index": turn.index,
                    "generation": turn.generation,
                    "stages_ns": dict(turn.timestamps),
                    "durations_ms": turn.durations(),
                    "interrupted": turn.interrupted,
                    "generated": "generated" in turn.timestamps,
                    "synthesized": "first_synthesized_audio" in turn.timestamps,
                    "submitted_to_transport": "first_transport_submission" in turn.timestamps,
                    "transport_stopped": turn.transport_stopped,
                    "playback": "partial_or_unknown" if turn.interrupted else "unknown",
                    "exact_playback_confirmed": False,
                }
            )
        summary: dict[str, Any] = {}
        for name in _DURATION_STAGES:
            values = sorted(
                value for turn in self._turns if (value := turn.durations()[name]) is not None
            )
            summary[name] = {
                "samples": len(values),
                "p50": values[math.ceil(len(values) * 0.50) - 1] if values else None,
                "p95": values[math.ceil(len(values) * 0.95) - 1] if values else None,
            }
        return {
            "schema_version": "1.0",
            "evidence": "pipeline_observation",
            "association": "serialized_request_and_tts_context",
            "percentile_method": "nearest_rank",
            "total_turns": self._turn_count,
            "retained_turns": len(turns),
            "stale_audio_frames": self._stale_audio_frames,
            "turns": turns,
            "summary_ms": summary,
            "limitations": ["no_remote_playback_receipt", "no_acoustic_quality_measurement"],
        }

    def finalize(self) -> dict[str, Any]:
        """Return the final snapshot; absence of an event remains unknown."""
        return self.snapshot()
