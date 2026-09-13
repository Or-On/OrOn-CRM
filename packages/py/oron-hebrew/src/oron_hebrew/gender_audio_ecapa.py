"""ECAPA-TDNN voice-gender classifier — the caller-gender detector.

Ported from Jpost's `gender_classifier.py` (the pipecat processor); the model
architecture it loads lives flat in `ecapa_model.py`, mirroring Jpost's
`ecapa_gender.py`. The source fetched inference weights from Hugging Face. The
target instead requires a verified local model path and exact SHA-256 and uses
`local_files_only=True`; no runtime download fallback exists.

torch/torchaudio are installed only through the optional ``gender`` dependency;
the classifier is unavailable until an operator deliberately selects that
runtime and supplies a licensed, checksum-pinned asset.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import ClassVar

import numpy as np
import torch
import torchaudio
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADAnalyzer, VADParams, VADState
from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from oron_hebrew.assets import ModelAssetError, verify_model_asset
from oron_hebrew.ecapa_model import ECAPA_gender

# STARTING counts: Silero flags it before it is certain, and the leading edge of
# an utterance is real speech we would otherwise drop.
_SPEAKING_STATES = (VADState.STARTING, VADState.SPEAKING)

# Matches the sensitivity the pipeline's own turn-taking VAD runs at. Pipecat's
# defaults (0.7/0.6) are stricter, and this gate used them: measured over 13
# carrier calls that cost half the caller's speech and two calls entirely,
# discarding audio the same caller had just taken a turn with. Carrier audio is
# quieter and band-limited, so min_volume is the binding constraint.
GENDER_VAD_PARAMS = VADParams(stop_secs=0.3, confidence=0.5, min_volume=0.35)


def _classify_pcm(model, pcm_bytes: bytes, sr: int) -> tuple[str, float]:
    """Run ECAPA gender classification on int16-LE mono PCM."""
    audio_np = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    audio_tensor = torch.from_numpy(audio_np).unsqueeze(0)  # [1, samples]

    if sr != 16000:
        audio_tensor = torchaudio.functional.resample(audio_tensor, orig_freq=sr, new_freq=16000)

    with torch.no_grad():
        logits = model(audio_tensor)
        probs = torch.softmax(logits, dim=1)[0]

    male_prob = float(probs[0])
    female_prob = float(probs[1])
    gender = "male" if male_prob > female_prob else "female"
    confidence = max(male_prob, female_prob)
    return gender, confidence


class GenderClassifierProcessor(FrameProcessor):
    """Classifies speaker gender from audio using ECAPA-TDNN.

    Loads only an explicitly configured, checksum-verified local model, buffers
    SPEECH, runs inference in a thread executor, and invokes
    `on_gender_classified(gender, confidence)`. All frames pass through
    unchanged. Missing or invalid local assets leave `available=False`; the
    processor never resolves or downloads a remote model.

    Buffering is VAD-gated, and that is not an optimisation — it is what makes
    the classifier correct. ECAPA has no notion of "this is not speech": fed the
    silence at the start of a call (the bot greets first, so the caller IS
    silent) it returns male at 0.81-0.99 confidence, above threshold, and the
    verdict LATCHES for the whole call. Every caller would be classified male
    before saying a word. Gating on Silero means the seconds counted are
    seconds of actual speech.
    """

    _model: ClassVar[object | None] = None
    _model_loaded: ClassVar[bool] = False
    _model_failed: ClassVar[bool] = False

    def __init__(
        self,
        required_seconds: float = 1.0,
        confidence_threshold: float = 0.7,
        max_seconds: float = 3.0,
        retry_interval_seconds: float = 0.5,
        confirmation_attempts: int = 1,
        on_gender_classified: Callable[[str, float], Awaitable[None]] | None = None,
        vad_analyzer: VADAnalyzer | None = None,
        is_bot_speaking: Callable[[], bool] | None = None,
        model_path: str | None = None,
        model_sha256: str | None = None,
        **kwargs,
    ):
        """Args:
        required_seconds: SPEECH buffered before the FIRST inference runs.
        confidence_threshold: below this a verdict is not accepted.
        max_seconds: speech buffered past which the verdict is taken as final
            (accepted, or reported "unknown" if still under threshold).
        retry_interval_seconds: extra speech required between low-confidence
            retries. Without it a retry fires on every ~20ms audio frame,
            i.e. ~100 inferences across a 1s->3s window.
        confirmation_attempts: matching high-confidence readings required before
            gender is accepted. A value above one trades a slightly later
            decision for fewer customer-facing misclassifications.
        vad_analyzer: speech gate. Injected so tests can drive it; defaults to
            its OWN Silero instance rather than sharing the turn-taking one,
            which is stateful and driven from another point in the pipeline.
        """
        super().__init__(**kwargs)
        self._required_seconds = required_seconds
        self._confidence_threshold = confidence_threshold
        self._max_seconds = max_seconds
        self._retry_interval_seconds = retry_interval_seconds
        if confirmation_attempts < 1:
            raise ValueError("confirmation_attempts must be at least 1")
        self._confirmation_attempts = confirmation_attempts
        self._on_gender_classified = on_gender_classified
        self._vad = (
            vad_analyzer
            if vad_analyzer is not None
            else SileroVADAnalyzer(params=GENDER_VAD_PARAMS)
        )
        # Injected because the bot-speaking signal originates at the transport
        # OUTPUT and flows downstream, so it never reaches this processor (which
        # sits on the input side). The caller owns the state; we only read it.
        self._is_bot_speaking = is_bot_speaking or (lambda: False)

        self._audio_buffer = bytearray()
        self._sample_rate: int | None = None
        self._num_channels: int | None = None
        self._classified = False
        self._classifying = False
        self._next_attempt_seconds = required_seconds
        self._candidate_gender: str | None = None
        self._candidate_confirmations = 0
        # Only audio inside the caller's OWN turn is buffered. The echo guard
        # below is a timing guess; this is not. Echo arrives when the caller is
        # not speaking, so the turn boundary excludes it by construction — which
        # matters because the buffer is never cleared, so any leak accumulates
        # for the rest of the call. Observed 2026-07-26: a male caller giving
        # three one-word answers against an agent speaking full sentences was
        # classified female at 0.90.
        self._in_user_turn = False

        self._ensure_model(model_path=model_path, expected_sha256=model_sha256)

    @property
    def available(self) -> bool:
        return self._model_loaded

    @classmethod
    def _ensure_model(
        cls,
        *,
        model_path: str | None,
        expected_sha256: str | None,
    ) -> None:
        """Load a verified local ECAPA asset once; never resolve a remote model."""
        if cls._model_loaded or cls._model_failed:
            return
        if model_path is None and expected_sha256 is None:
            return
        try:
            verified = verify_model_asset(model_path, expected_sha256)
            if verified is None:
                return
            model = ECAPA_gender.from_pretrained(str(verified), local_files_only=True)
            model.eval()
            cls._model = model
            cls._model_loaded = True
            logger.info("[GenderClassifierProcessor] verified local ECAPA-TDNN loaded")
        except ModelAssetError, OSError, RuntimeError, ValueError:
            cls._model_failed = True
            logger.error("[GenderClassifierProcessor] pinned local ECAPA model unavailable")

    def _buffered_seconds(self) -> float:
        if not self._sample_rate or not self._num_channels:
            return 0.0
        bytes_per_second = self._sample_rate * self._num_channels * 2  # 16-bit PCM
        return len(self._audio_buffer) / bytes_per_second

    def _classify(self) -> tuple[str, float]:
        """Run classification on the buffered audio. Called in a thread executor."""
        if self._sample_rate is None:
            raise RuntimeError("classification requested before any audio frame set the rate")
        return _classify_pcm(self._model, bytes(self._audio_buffer), self._sample_rate)

    async def _run_classification(self) -> None:
        loop = asyncio.get_event_loop()
        try:
            gender, confidence = await loop.run_in_executor(None, self._classify)
        except Exception as e:
            logger.error(f"[GenderClassifierProcessor] classification failed: {e!r}")
            self._classified = True
            return

        seconds = self._buffered_seconds()
        if confidence >= self._confidence_threshold:
            if gender == self._candidate_gender:
                self._candidate_confirmations += 1
            else:
                self._candidate_gender = gender
                self._candidate_confirmations = 1
        else:
            self._candidate_gender = None
            self._candidate_confirmations = 0

        confirmed = self._candidate_confirmations >= self._confirmation_attempts
        if not confirmed and seconds < self._max_seconds:
            logger.warning(
                "[GenderClassifierProcessor] verdict not yet stable "
                f"({gender}, confidence={confidence:.2f}, "
                f"confirmations={self._candidate_confirmations}/{self._confirmation_attempts}); "
                f"continuing to buffer ({seconds:.1f}s / {self._max_seconds}s max)"
            )
            self._classifying = False
            return

        if not confirmed:
            gender = "unknown"

        self._classified = True
        logger.info(f"[GenderClassifierProcessor] result: {gender} (confidence: {confidence:.2f})")

        if self._on_gender_classified is not None:
            await self._on_gender_classified(gender, confidence)

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, UserStartedSpeakingFrame):
            self._in_user_turn = True
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self._in_user_turn = False

        if self.available and not self._classified and isinstance(frame, InputAudioRawFrame):
            if not self._in_user_turn:
                await self.push_frame(frame, direction)
                return
            if self._sample_rate is None:
                self._sample_rate = frame.sample_rate
                self._num_channels = frame.num_channels
                self._vad.set_sample_rate(frame.sample_rate)

            # Never buffer while the BOT is speaking. Inbound audio then is
            # almost always the bot's own voice echoing back through the
            # caller's speakers, and the bot's voice is female — which the
            # classifier will happily report at 0.9+ confidence, and the verdict
            # LATCHES. Observed 2026-07-24: a male caller classified female
            # (0.94). Barge-in audio is lost for gender purposes, which is a
            # cheap price: a call supplies plenty of clean caller speech.
            if self._is_bot_speaking():
                await self.push_frame(frame, direction)
                return

            # Only speech reaches the buffer. Non-speech would still produce a
            # confident (wrong) verdict, and the verdict latches.
            if await self._vad.analyze_audio(frame.audio) not in _SPEAKING_STATES:
                await self.push_frame(frame, direction)
                return

            self._audio_buffer.extend(frame.audio)

            if not self._classifying and self._buffered_seconds() >= self._next_attempt_seconds:
                self._classifying = True
                self._next_attempt_seconds = self._buffered_seconds() + self._retry_interval_seconds
                asyncio.create_task(self._run_classification())

        await self.push_frame(frame, direction)
