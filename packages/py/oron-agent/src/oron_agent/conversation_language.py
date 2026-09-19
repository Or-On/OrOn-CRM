"""Provider-backed conversation language for STT context and TTS delivery.

Language is transport metadata, never a conversational intent. Soniox v5
identifies the dominant language of each finalized utterance from token-level
labels; this module carries that value to the model and synthesizer without
guessing from scripts, keywords, browser locale, or a Hebrew/English state
machine.
"""

from __future__ import annotations

import re

from pipecat.frames.frames import (
    AggregatedTextFrame,
    Frame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMMessagesAppendFrame,
    TranscriptionFrame,
    TTSUpdateSettingsFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.transcriptions.language import Language

_LANGUAGE_MARKER = re.compile(
    r"<lang:(?P<language>[a-z]{2,3}(?:-[a-z0-9]{2,8})?)>",
    re.IGNORECASE,
)


def normalize_language(value: object, fallback: str | None = None) -> str | None:
    """Return a supported base ISO language code supplied by the provider."""

    raw = value.value if isinstance(value, Language) else value
    normalized = str(raw or "").strip().lower().replace("_", "-")
    if normalized:
        base = normalized.split("-", 1)[0]
        try:
            Language(base)
        except ValueError:
            pass
        else:
            return base
    if fallback is None:
        return None
    return normalize_language(fallback)


def conversation_language_instruction(language: str) -> str:
    """Describe speech metadata without deciding what the assistant may say."""

    return (
        f"SPEECH LANGUAGE METADATA: Soniox identified the latest completed caller "
        f"utterance as language code '{language}'. Treat the full utterance as a "
        "normal user message and respond to every meaningful part. Choose the reply "
        "language from the dominant meaningful content of the complete utterance, not "
        "from a brief filler, acknowledgement, loanword, or its first word alone. A "
        "deliberate language switch or explicit request should be followed immediately. "
        "This metadata is a delivery hint only and must not route, classify, reject, or "
        "replace the caller's message."
    )


class ConversationLanguageState:
    """Call-local primary language, updated only from finalized Soniox metadata."""

    def __init__(self, default: str):
        self.default = normalize_language(default, "en") or "en"
        self.current = self.default

    def observe(self, frame: TranscriptionFrame) -> bool:
        detected = normalize_language(frame.language)
        if detected is None or detected == self.current:
            return False
        self.current = detected
        return True


class CallerLanguageContextProcessor(FrameProcessor):
    """Place final provider language metadata before its triggering user turn."""

    def __init__(self, state: ConversationLanguageState, **kwargs):
        super().__init__(**kwargs)
        self._state = state

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if (
            direction is FrameDirection.DOWNSTREAM
            and isinstance(frame, TranscriptionFrame)
            and frame.finalized
            and self._state.observe(frame)
        ):
            await self.push_frame(
                LLMMessagesAppendFrame(
                    messages=[
                        {
                            "role": "system",
                            "content": conversation_language_instruction(self._state.current),
                        }
                    ],
                    run_llm=False,
                ),
                direction,
            )
        await self.push_frame(frame, direction)


def tts_language(language: str) -> Language:
    """Convert provider metadata to Pipecat's generic TTS language value."""

    try:
        return Language(language)
    except ValueError:
        return Language.EN


def response_language(text: str, fallback: str) -> tuple[str, str]:
    """Read the model's leading delivery marker and remove all marker text."""

    leading = _LANGUAGE_MARKER.match(text.lstrip())
    requested = normalize_language(leading.group("language")) if leading else None
    cleaned = " ".join(_LANGUAGE_MARKER.sub(" ", text).split())
    return requested or normalize_language(fallback, "en") or "en", cleaned


class ResponseLanguageTTSProcessor(FrameProcessor):
    """Apply and remove the model's per-response primary-language metadata."""

    def __init__(self, state: ConversationLanguageState, **kwargs):
        super().__init__(**kwargs)
        self._state = state
        self._applied = state.default
        self._awaiting_primary = True

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction is not FrameDirection.DOWNSTREAM:
            await self.push_frame(frame, direction)
            return
        if isinstance(frame, (LLMFullResponseStartFrame, InterruptionFrame)):
            self._awaiting_primary = True
            await self.push_frame(frame, direction)
            return
        if isinstance(frame, LLMFullResponseEndFrame):
            self._awaiting_primary = True
            await self.push_frame(frame, direction)
            return
        if isinstance(frame, AggregatedTextFrame) and self._awaiting_primary:
            primary, frame.text = response_language(frame.text, self._state.current)
            if frame.raw_text is not None:
                _, frame.raw_text = response_language(frame.raw_text, self._state.current)
            self._awaiting_primary = False
            if primary != self._applied:
                self._applied = primary
                await self.push_frame(
                    TTSUpdateSettingsFrame(settings={"language": tts_language(primary)}),
                    direction,
                )
            if not frame.text.strip():
                return
        elif isinstance(frame, AggregatedTextFrame):
            _, frame.text = response_language(frame.text, self._state.current)
            if frame.raw_text is not None:
                _, frame.raw_text = response_language(frame.raw_text, self._state.current)
            if not frame.text.strip():
                return
        await self.push_frame(frame, direction)
