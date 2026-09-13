"""Published voice-quality configuration at the retained provider boundary.

No credentials, provider defaults, knowledge or actions are accepted here.
The caller supplies the already tenant-authorized, immutable profile version.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from typing import Literal

from oron_hebrew.filters import HebrewNormalizeFilter
from oron_hebrew.pronunciation import is_safe_pronunciation_pair
from pipecat.services.soniox.stt import SonioxContextObject
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

_MARKUP = re.compile(r"[<>\[\]{}\x00-\x1f\x7f]")


class PronunciationEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    original: str = Field(min_length=1, max_length=80)
    spoken: str = Field(min_length=1, max_length=80)
    language: Literal["he", "en"]
    context: str = Field(default="", max_length=120)
    testCases: list[str] = Field(default_factory=list, max_length=8)

    @field_validator("original", "spoken", "context")
    @classmethod
    def safe_text(cls, value: str) -> str:
        if _MARKUP.search(value):
            raise ValueError("Pronunciation entries must contain plain text")
        return value.strip()

    @field_validator("testCases")
    @classmethod
    def bounded_cases(cls, values: list[str]) -> list[str]:
        if any(not value.strip() or len(value) > 240 or _MARKUP.search(value) for value in values):
            raise ValueError("Pronunciation test cases must be bounded plain text")
        return values

    @model_validator(mode="after")
    def preserve_critical_meaning(self) -> PronunciationEntry:
        if not is_safe_pronunciation_pair(self.original, self.spoken):
            raise ValueError("Pronunciation entries must preserve lexical and critical meaning")
        return self


class VoiceBudgets(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    maxResponseTokens: int = Field(default=256, ge=64, le=2048)
    maxSessionSeconds: int = Field(default=900, ge=60, le=3600)


class VoiceQualityConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schemaVersion: Literal["1.0"] = "1.0"
    language: Literal["he", "en"] = "he"
    agentGrammar: Literal["feminine", "masculine", "neutral"] = "feminine"
    callerAddressDefault: Literal["unknown", "feminine", "masculine", "neutral"] = "unknown"
    speakingStyle: Literal["concise", "balanced", "detailed"] = "concise"
    speakingPace: float = Field(default=1.0, ge=0.75, le=1.25)
    voiceId: str = Field(default="", max_length=120)
    sttVocabulary: list[str] = Field(default_factory=list, max_length=64)
    pronunciationDictionary: list[PronunciationEntry] = Field(default_factory=list, max_length=64)
    budgets: VoiceBudgets = Field(default_factory=VoiceBudgets)
    fallbackBehavior: Literal["clarify", "handoff"] = "clarify"

    @field_validator("sttVocabulary")
    @classmethod
    def bounded_vocabulary(cls, values: list[str]) -> list[str]:
        unique: list[str] = []
        for value in values:
            term = " ".join(value.split())
            if not term or len(term) > 80 or _MARKUP.search(value):
                raise ValueError("STT vocabulary must contain bounded plain terms")
            if term.casefold() not in {existing.casefold() for existing in unique}:
                unique.append(term)
        if sum(map(len, unique)) > 2048:
            raise ValueError("STT vocabulary exceeds its 2048-character budget")
        return unique

    @model_validator(mode="after")
    def distinct_pronunciations(self) -> VoiceQualityConfig:
        keys = [
            (entry.language, entry.original.casefold(), entry.context.casefold())
            for entry in self.pronunciationDictionary
        ]
        if len(keys) != len(set(keys)):
            raise ValueError("Pronunciation entries must be unique for their language/context")
        return self


def build_soniox_context(config: VoiceQualityConfig) -> SonioxContextObject | None:
    """Use the installed SDK's supported terms field; omit empty context."""
    return SonioxContextObject(terms=list(config.sttVocabulary)) if config.sttVocabulary else None


def make_speech_transformer(
    config: VoiceQualityConfig,
    get_caller_address: Callable[[], str | None],
) -> Callable[[str, object], Awaitable[str]]:
    """Return a speech-only transform for TTSService.add_text_transformer.

    Context is a literal cue in the authored utterance, never an instruction.
    Substitutions are whole-token and simultaneous so one entry cannot trigger
    another. Canonical frame text and conversation history are untouched.
    """
    normalizer = HebrewNormalizeFilter(get_caller_address)

    async def transform(text: str, _aggregation_type: object) -> str:
        authored = text
        entries = {
            entry.original: entry.spoken
            for entry in config.pronunciationDictionary
            if entry.language == config.language
            and (not entry.context or entry.context.casefold() in authored.casefold())
        }
        if entries:
            pattern = re.compile(
                r"(?<![\w\u0591-\u05c7])(?:"
                + "|".join(re.escape(key) for key in sorted(entries, key=len, reverse=True))
                + r")(?![\w\u0591-\u05c7])"
            )
            text = pattern.sub(lambda match: entries[match.group()], text)
        return await normalizer.filter(text) if config.language == "he" else text

    return transform
