"""Bounded, content-free timing evidence from the running Pipecat pipeline.

Two layers, deliberately not merged:

* This observer's own stages correlate timing with the boundaries only this
  product has — recognition acceptance, grounding validation, the voice
  ownership generation, and whether audio arrived after an interruption. They
  are evidence about correctness as much as about speed.
* Pipecat's :class:`~pipecat.observers.user_bot_latency_observer.LatencyBreakdown`
  (1.9.0+) attributes the caller-stop → bot-speaking interval part by part, and
  its parts sum to the measured total. It names time no processor reports —
  VAD silence, endpointing wait, sentence aggregation — and credits the SETTING
  responsible rather than the service hosting it.

Component attribution is taken from Pipecat rather than re-derived here, so
there is one authority for "where did the second go" and one for "was this turn
correct".
"""

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
from pipecat.observers.user_bot_latency_observer import LatencyBreakdown, UserBotLatencyObserver
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


def _percentiles(values: list[float]) -> dict[str, Any]:
    """Nearest-rank p50/p95, which is what the artifact documents."""
    ordered = sorted(values)
    return {
        "samples": len(ordered),
        "p50": ordered[math.ceil(len(ordered) * 0.50) - 1] if ordered else None,
        "p95": ordered[math.ceil(len(ordered) * 0.95) - 1] if ordered else None,
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
            if start_ns is None or end_ns is None:
                values[name] = None
                continue
            # Soniox may finalize the accepted utterance a few milliseconds
            # before Pipecat emits its VAD stop marker. That means the accepted
            # text was already ready when speech ended, not that the stage was
            # unobserved. Keep other out-of-order stages unknown because those
            # would indicate a broken correlation rather than zero latency.
            if name == "speech_end_to_accepted_ms":
                values[name] = round(max(0, end_ns - start_ns) / 1_000_000, 3)
            else:
                values[name] = (
                    round((end_ns - start_ns) / 1_000_000, 3) if end_ns >= start_ns else None
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
        self._breakdowns: deque[dict[str, Any]] = deque(maxlen=max_turns)

    async def record_latency_breakdown(self, breakdown: LatencyBreakdown) -> None:
        """Take Pipecat's component attribution for one caller→bot cycle.

        Only names, owners and durations are kept: a contribution's label is
        pipeline vocabulary, never conversation content. Registered as the
        `on_latency_breakdown` handler, so it is async to match the event.
        """
        self._breakdowns.append(
            {
                "measured_from": (
                    breakdown.measured_from.value if breakdown.measured_from else None
                ),
                "total_ms": round(breakdown.total_secs * 1000, 3),
                "contributions": [
                    {
                        "key": part.key,
                        "label": part.label,
                        "owner": part.owner,
                        "owner_kind": part.owner_kind.value,
                        "duration_ms": round(part.duration_secs * 1000, 3),
                    }
                    for part in breakdown.contributions
                ],
            }
        )

    def _component_summary(self) -> dict[str, Any]:
        """p50/p95 per contribution key, plus the end-to-end total.

        The key, not the label: a reworded label must not split one component's
        history into two series.
        """
        series: dict[str, list[float]] = {}
        for record in self._breakdowns:
            series.setdefault("total", []).append(record["total_ms"])
            for part in record["contributions"]:
                series.setdefault(part["key"], []).append(part["duration_ms"])
        return {key: _percentiles(values) for key, values in sorted(series.items())}

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
        elif isinstance(frame, InterruptionFrame) and not turn.transport_stopped:
            # Pipecat also broadcasts an InterruptionFrame when the caller
            # starts a normal next turn. Once transport has reported that the
            # preceding bot turn stopped, that frame is not a barge-in and must
            # not make a completed response look partial in quality evidence.
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
            summary[name] = _percentiles(
                [value for turn in self._turns if (value := turn.durations()[name]) is not None]
            )
        return {
            "schema_version": "1.1",
            # Pipecat's own attribution of caller-stop -> bot-speaking. Kept
            # beside the stages above rather than replacing them: these name
            # the settings and services that spent the time, those correlate
            # the same turn with recognition, grounding and ownership.
            "component_latency": {
                "source": "pipecat_latency_breakdown",
                "cycles": list(self._breakdowns),
                "summary_ms": self._component_summary(),
            },
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


def component_latency_observer(
    quality: VoiceQualityObserver, *, tracing_enabled: bool
) -> UserBotLatencyObserver | None:
    """The latency observer to register, or None when pipecat already has one.

    `PipelineWorker` builds its own `UserBotLatencyObserver` as part of the
    tracing stack, and exposes no accessor for it. Registering a second one
    under `enable_tracing` would observe every frame twice to produce a
    breakdown the trace spans already carry, and hand-building that stack is
    the mistake `test_pipecat_owns_the_tracing_stack` exists to prevent.

    Tracing is off by default, and that is the configuration a live call runs
    in — so without this the component breakdown would exist only for the
    sessions nobody is measuring.
    """
    if tracing_enabled:
        return None
    observer = UserBotLatencyObserver()

    # `async def`, not a lambda: pipecat awaits a handler only when it is a
    # coroutine FUNCTION, so a lambda returning a coroutine is called, never
    # awaited, and the breakdown is silently dropped.
    async def record(_observer: UserBotLatencyObserver, breakdown: LatencyBreakdown) -> None:
        await quality.record_latency_breakdown(breakdown)

    observer.add_event_handler("on_latency_breakdown", record)
    return observer
