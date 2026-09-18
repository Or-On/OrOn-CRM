"""Published voice-quality configuration at the retained provider boundary.

No credentials, provider defaults, knowledge or actions are accepted here.
The caller supplies the already tenant-authorized, immutable profile version.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Awaitable, Callable, Mapping
from typing import Literal

from oron_hebrew.filters import HebrewNormalizeFilter
from oron_hebrew.pronunciation import is_safe_pronunciation_pair
from pipecat.services.soniox.stt import SonioxContextGeneralItem, SonioxContextObject
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


# Soniox rejects a context object above 8000 tokens (~10000 characters) with
# invalid_request, which would fail the STT connect rather than degrade it. The
# budget below is the serialized size WE will send, kept far under that ceiling:
# the context travels on every connect, including the reconnect after an
# operator pause, and a recognizer prompt is orientation, not a knowledge base.
_CONTEXT_CHARACTER_BUDGET = 4000
# "Keep key-value pairs terse and few: ideally 10 or fewer" (Soniox context
# guidance). Every key here is a fixed literal chosen by this module.
_MAX_GENERAL_ITEMS = 6
_MAX_GENERAL_VALUE = 240
_MAX_TERMS = 128
_MAX_TERM_LENGTH = 80


def _plain(value: object, limit: int) -> str:
    """Collapse published prose to bounded single-line plain text.

    Markup characters are dropped rather than escaped: this string becomes a
    JSON value in the recognizer's context, and the only safe reading of a
    bracket or angle bracket arriving from stored configuration is "not markup
    we authored".
    """
    if not isinstance(value, str):
        return ""
    text = " ".join(_MARKUP.sub(" ", value).split())
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip(" ,;.-")


def _unpointed(value: str) -> str:
    return "".join(
        char for char in unicodedata.normalize("NFD", value) if not unicodedata.combining(char)
    )


class RecognitionContextProfile(BaseModel):
    """The non-personal slice of the published tenant profile STT may see.

    Built from the same immutable agent/tenant version the prompt is compiled
    from, never from the live call: no caller transcript, CRM record, knowledge
    document, handoff context or credential reaches this model. That is the
    whole boundary — recognition context is a hint about which words exist in
    this business, not a place to widen what the provider learns about a
    customer.

    Keys in the emitted context are fixed literals chosen here, so stored text
    can only ever become a VALUE. An operator cannot name a key such as
    ``instructions`` and turn published configuration into recognizer
    direction.
    """

    model_config = ConfigDict(extra="ignore", frozen=True)

    organization: str = Field(default="", max_length=160)
    description: str = Field(default="", max_length=2000)
    products: list[str] = Field(default_factory=list, max_length=64)
    affiliations: list[str] = Field(default_factory=list, max_length=32)

    @classmethod
    def from_configuration(cls, configuration: Mapping[str, object]) -> RecognitionContextProfile:
        """Read the published support profile defensively; absence is not an error."""
        profile = configuration.get("supportProfile")
        if not isinstance(profile, Mapping):
            return cls()
        return cls(
            organization=_plain(profile.get("supportDisplayName"), 160),
            description=_plain(profile.get("businessDescription"), 2000),
            products=_bounded_list(profile.get("productsAndServices")),
            affiliations=_bounded_list(profile.get("authorizedAffiliations")),
        )


def _bounded_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    cleaned: list[str] = []
    for item in value:
        term = _plain(item, _MAX_TERM_LENGTH)
        if term and term not in cleaned:
            cleaned.append(term)
    return cleaned


def _recognition_terms(config: VoiceQualityConfig, profile: RecognitionContextProfile) -> list[str]:
    """Literal spellings the caller is likely to say, in descending confidence.

    The published vocabulary comes first because an operator typed it FOR
    recognition. Pronunciation originals follow: those are the exact brand and
    product spellings the same operator curated for the voice, and a word worth
    teaching the synthesizer is a word worth teaching the recognizer. Niqqud is
    stripped — a caller says the word, not its vowel marks, and a pointed term
    would never match a recognizer token.
    """
    seen: set[str] = set()
    terms: list[str] = []
    for candidate in (
        *config.sttVocabulary,
        *(entry.original for entry in config.pronunciationDictionary),
        *profile.products,
        *profile.affiliations,
        profile.organization,
    ):
        term = _plain(_unpointed(candidate), _MAX_TERM_LENGTH)
        key = term.casefold()
        if term and key not in seen:
            seen.add(key)
            terms.append(term)
        if len(terms) >= _MAX_TERMS:
            break
    return terms


def _general_items(profile: RecognitionContextProfile) -> list[SonioxContextGeneralItem]:
    """Terse orientation. Soniox's own guidance is to lead with this.

    It works where `terms` cannot: it biases vocabulary selection and resolves
    homophones for words nobody listed, which is most of what a caller says.

    Only tenant-published facts go in. A constant English scene-setter ("a
    support phone call") was considered and rejected: Soniox documents English
    prose in `general` as able to steer language identification, this platform
    is Hebrew-first with `language_hints` already carrying that decision, and
    the trade cannot be measured without a provider-backed Hebrew A/B. An
    unmeasurable nudge toward English is the wrong default here.
    """
    pairs = [
        ("organization", profile.organization),
        ("domain", profile.description),
        ("products", ", ".join(profile.products)),
        ("affiliations", ", ".join(profile.affiliations)),
    ]
    return [
        SonioxContextGeneralItem(key=key, value=_plain(value, _MAX_GENERAL_VALUE))
        for key, value in pairs
        if _plain(value, _MAX_GENERAL_VALUE)
    ][:_MAX_GENERAL_ITEMS]


def _context_size(context: SonioxContextObject) -> int:
    dumped = context.model_dump(exclude_none=True)
    return sum(
        len(key) + sum(len(str(part)) for part in _leaves(value)) for key, value in dumped.items()
    )


def _leaves(value: object) -> list[object]:
    if isinstance(value, dict):
        return [leaf for item in value.values() for leaf in _leaves(item)]
    if isinstance(value, list):
        return [leaf for item in value for leaf in _leaves(item)]
    return [value]


def build_soniox_context(
    config: VoiceQualityConfig,
    profile: RecognitionContextProfile | None = None,
) -> SonioxContextObject | None:
    """Publish bounded recognition context; omit it entirely when empty.

    `general` and `terms` are the two fields Soniox documents as influential.
    `text` is deliberately unused: it is documented as the weakest field and is
    the only one that invites bulk prose, which is exactly the material that
    should not leave the prompt boundary.

    Over budget, `general` is kept and `terms` is truncated — orientation
    generalizes to every word in the turn, while one more listed term helps
    only if the caller happens to say it.
    """
    profile = profile or RecognitionContextProfile()
    general = _general_items(profile)
    terms = _recognition_terms(config, profile)
    if not general and not terms:
        return None
    context = SonioxContextObject(general=general or None, terms=terms or None)
    while terms and _context_size(context) > _CONTEXT_CHARACTER_BUDGET:
        terms = terms[:-1]
        context = SonioxContextObject(general=general or None, terms=terms or None)
    return context


def make_speech_transformer(
    config: VoiceQualityConfig,
    get_caller_address: Callable[[], str | None],
    *,
    get_language: Callable[[], str] | None = None,
) -> Callable[[str, object], Awaitable[str]]:
    """Return a speech-only transform for TTSService.add_text_transformer.

    Context is a literal cue in the authored utterance, never an instruction.
    Substitutions are whole-token and simultaneous so one entry cannot trigger
    another. Canonical frame text and conversation history are untouched.
    """
    normalizer = HebrewNormalizeFilter(get_caller_address)

    async def transform(text: str, _aggregation_type: object) -> str:
        authored = text
        requested_language = get_language() if get_language is not None else config.language
        language = requested_language if requested_language in {"he", "en"} else config.language
        entries = {
            entry.original: entry.spoken
            for entry in config.pronunciationDictionary
            if entry.language == language
            and (not entry.context or entry.context.casefold() in authored.casefold())
        }
        if entries:
            pattern = re.compile(
                r"(?<![\w\u0591-\u05c7])(?:"
                + "|".join(re.escape(key) for key in sorted(entries, key=len, reverse=True))
                + r")(?![\w\u0591-\u05c7])"
            )
            text = pattern.sub(lambda match: entries[match.group()], text)
        return await normalizer.filter(text) if language == "he" else text

    return transform
