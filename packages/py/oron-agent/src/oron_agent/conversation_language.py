"""Call-local Hebrew/English routing for model context and speech synthesis."""

from __future__ import annotations

import re
from enum import StrEnum

from pipecat.frames.frames import (
    AggregatedTextFrame,
    Frame,
    LLMMessagesAppendFrame,
    TranscriptionFrame,
    TTSUpdateSettingsFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.transcriptions.language import Language

_HEBREW_LETTER = re.compile(r"[\u05d0-\u05ea]")
_LATIN_LETTER = re.compile(r"[A-Za-z]")


class ConversationLanguage(StrEnum):
    HEBREW = "he"
    ENGLISH = "en"


def _language_from_provider(value: object) -> ConversationLanguage | None:
    normalized = str(value or "").lower().replace("_", "-")
    if normalized == "he" or normalized.startswith("he-"):
        return ConversationLanguage.HEBREW
    if normalized == "en" or normalized.startswith("en-"):
        return ConversationLanguage.ENGLISH
    return None


def detect_conversation_language(
    text: str,
    provider_language: object = None,
) -> ConversationLanguage | None:
    """Resolve a meaningful Hebrew/English turn without guessing from punctuation.

    Soniox identifies language at token level, but Pipecat exposes one language on
    the accepted turn. Script counts are authoritative for clear text; the
    provider value breaks ties and handles short Latin/Hebrew utterances.
    """

    hebrew = len(_HEBREW_LETTER.findall(text))
    latin = len(_LATIN_LETTER.findall(text))
    provider = _language_from_provider(provider_language)
    # Product and person names often use the other script and can be longer
    # than the surrounding utterance. Soniox's turn-level identification is the
    # better tie-breaker when both scripts are genuinely present.
    if hebrew and latin and provider is not None:
        return provider
    if hebrew >= 2 and hebrew > latin:
        return ConversationLanguage.HEBREW
    if latin >= 2 and latin > hebrew:
        return ConversationLanguage.ENGLISH
    return provider


def conversation_language_instruction(language: ConversationLanguage) -> str:
    if language is ConversationLanguage.ENGLISH:
        return (
            "CURRENT TURN LANGUAGE: The caller's latest accepted turn is English. "
            "Understand it and respond entirely in concise, natural English. This "
            "per-turn rule overrides a Hebrew flow default for this reply. Keep "
            "names in their normal form and ask at most one question."
        )
    return (
        "CURRENT TURN LANGUAGE: The caller's latest accepted turn is Hebrew. "
        "Understand it and respond entirely in concise, natural Israeli Hebrew. "
        "This per-turn rule overrides an English flow default for this reply. Do "
        "not add niqqud or transliterate Hebrew, and ask at most one question."
    )


class ConversationLanguageState:
    """Mutable state scoped to one call; the authored flow language is the fallback."""

    def __init__(self, default: str):
        self.default = (
            ConversationLanguage.HEBREW
            if str(default).lower().startswith("he")
            else ConversationLanguage.ENGLISH
        )
        self.current = self.default

    def observe(self, frame: TranscriptionFrame) -> bool:
        detected = detect_conversation_language(frame.text, frame.language)
        if detected is None or detected is self.current:
            return False
        self.current = detected
        return True


class CallerLanguageContextProcessor(FrameProcessor):
    """Place a language switch in context before its triggering user turn."""

    def __init__(self, state: ConversationLanguageState, **kwargs):
        super().__init__(**kwargs)
        self._state = state

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if (
            direction is FrameDirection.DOWNSTREAM
            and isinstance(frame, TranscriptionFrame)
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


def tts_language(language: ConversationLanguage) -> Language:
    return Language.HE_IL if language is ConversationLanguage.HEBREW else Language.EN_US


class ResponseLanguageTTSProcessor(FrameProcessor):
    """Switch the TTS primary language immediately before each spoken response."""

    def __init__(self, state: ConversationLanguageState, **kwargs):
        super().__init__(**kwargs)
        self._state = state
        self._applied = state.default

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if (
            direction is FrameDirection.DOWNSTREAM
            and isinstance(frame, AggregatedTextFrame)
            and self._state.current is not self._applied
        ):
            self._applied = self._state.current
            await self.push_frame(
                TTSUpdateSettingsFrame(settings={"language": tts_language(self._applied)}),
                direction,
            )
        await self.push_frame(frame, direction)
