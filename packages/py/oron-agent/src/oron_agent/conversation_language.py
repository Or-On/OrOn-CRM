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
_URL = re.compile(r"https?://\S+", re.IGNORECASE)
_EMAIL = re.compile(r"\b[^\s@]+@[^\s@]+\.[^\s@]+\b", re.IGNORECASE)
_MACHINE_IDENTIFIER = re.compile(
    r"(?<!\w)(?=\S*[A-Za-z\u05d0-\u05ea])(?=\S*\d)"
    r"[A-Za-z\u05d0-\u05ea0-9._/-]+(?!\w)",
    re.IGNORECASE,
)
_LANGUAGE_WORD = re.compile(r"[\u05d0-\u05ea]+|[A-Za-z]+")
_TITLE_CASE_LATIN = re.compile(r"[A-Z][A-Za-z0-9]*")
_LATIN_ACRONYM = re.compile(r"[A-Z]{2,}[A-Z0-9]*")


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

    # Links, email addresses and machine identifiers are evidence, not a
    # reliable language signal. A Hebrew caller pasting a long support URL or
    # saying an English-looking error code must still receive a Hebrew turn.
    natural_text = _MACHINE_IDENTIFIER.sub(
        " ",
        _EMAIL.sub(" ", _URL.sub(" ", text)),
    )
    words = _LANGUAGE_WORD.findall(natural_text)
    technical_indexes: set[int] = set()
    index = 0
    while index < len(words):
        if not _TITLE_CASE_LATIN.fullmatch(words[index]):
            index += 1
            continue
        end = index + 1
        while end < len(words) and _TITLE_CASE_LATIN.fullmatch(words[end]):
            end += 1
        if end - index >= 2:
            technical_indexes.update(range(index, end))
        index = end
    words_without_technical_names = [
        word
        for word_index, word in enumerate(words)
        if word_index not in technical_indexes and not _LATIN_ACRONYM.fullmatch(word)
    ]
    words_without_acronyms = [word for word in words if not _LATIN_ACRONYM.fullmatch(word)]
    # A multi-word Title Case sequence is treated as a probable product/person
    # name only when some surrounding language remains. This preserves ordinary
    # short utterances such as "Please Help". Likewise, restore all-uppercase
    # words when they are the only signal so urgent messages such as "HELP" and
    # "NOT WORKING" are still recognized as English.
    language_words = words_without_technical_names or words_without_acronyms or words
    meaningful_letters = sum(
        len(_HEBREW_LETTER.findall(word)) + len(_LATIN_LETTER.findall(word))
        for word in language_words
    )
    # A single isolated letter is usually noise, an initial, or a partial STT
    # token. It must not flip an established bilingual conversation.
    if meaningful_letters < 2:
        return None
    hebrew = sum(bool(_HEBREW_LETTER.search(word)) for word in language_words)
    latin = sum(bool(_LATIN_LETTER.search(word)) for word in language_words)
    provider = _language_from_provider(provider_language)
    # Product and person names often use the other script and can be longer
    # than the surrounding utterance. Soniox's turn-level identification is the
    # better tie-breaker when both scripts are genuinely present.
    if hebrew == latin and hebrew > 0 and provider is not None:
        return provider
    if hebrew > latin:
        return ConversationLanguage.HEBREW
    if latin > hebrew:
        return ConversationLanguage.ENGLISH
    return None


def resolve_conversation_language(
    text: str,
    fallback: str,
    provider_language: object = None,
) -> ConversationLanguage:
    """Resolve one turn, retaining the authored language only when it is ambiguous.

    Typed evaluations do not carry Soniox metadata, while live calls do. Keeping
    the fallback in this shared helper makes both paths apply the same script
    rules without treating digits, punctuation, or silence as a language switch.
    """

    detected = detect_conversation_language(text, provider_language)
    if detected is not None:
        return detected
    return (
        ConversationLanguage.HEBREW
        if str(fallback).lower().startswith("he")
        else ConversationLanguage.ENGLISH
    )


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
        self.default = resolve_conversation_language("", default)
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
