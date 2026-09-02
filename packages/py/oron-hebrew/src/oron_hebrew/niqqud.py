"""Niqqud text-transformer — the pronunciation lever (Options Decision 1).

Registered via GeminiTTSService.add_text_transformer(...); mutates ONLY the text
sent to the vendor, so the assistant context aggregator keeps clean, unpointed
Hebrew. Steps: Hebrew-gate -> protect number/time words (Dicta niqqud, because
vocalize mis-points numbers) -> gender-conditioned G2P.vocalize(speaker=persona,
target_speaker=caller) -> restore. G2P is INJECTED (built once in oron-agent);
g2p=None degrades to passthrough.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable

from loguru import logger
from renikud_onnx import G2P

from oron_hebrew.g2p import gender_to_speaker
from oron_hebrew.numbers import _PH_CLOSE, _PH_OPEN, protect_numbers, restore_numbers

_HEBREW_LETTER_RE = re.compile(r"[א-ת]")


def _protect_lexicon(text: str, lexicon: dict[str, str]) -> tuple[str, dict[str, str]]:
    """Swap authored spoken forms out of reach of the G2P.

    The same private-use placeholders the number rules use: the G2P passes them
    through, so the authored pointing is what reaches TTS. Without this the model
    re-points the word and a name like אלי comes back as "Ili" instead of "Eli",
    which no prompt instruction can fix — the scripted `say` lines never go
    through the model at all.
    """
    restore: dict[str, str] = {}
    for i, (written, spoken) in enumerate(lexicon.items()):
        if written and written in text:
            ph = f"{_PH_OPEN}L{i}{_PH_CLOSE}"
            text = text.replace(written, ph)
            restore[ph] = spoken
    return text, restore


def make_hebrew_niqqud_transformer(
    g2p: G2P | None,
    get_caller_gender: Callable[[], str | None],
    persona_gender: str = "female",
    pronunciations: dict[str, str] | None = None,
) -> Callable[[str, object], Awaitable[str]]:
    # The persona is female by default, matching the voice we ship.
    persona_speaker = gender_to_speaker(persona_gender)
    lexicon = pronunciations or {}

    async def transform(text: str, _aggregation_type: object) -> str:
        if not text or not _HEBREW_LETTER_RE.search(text):
            return text
        try:
            protected, lex_restore = _protect_lexicon(text, lexicon)
            # Pointing off (or no model loaded) still owes the author their
            # spoken forms: the lexicon exists to fix names the vendor gets
            # wrong, and it gets them wrong pointed or not.
            if g2p is None:
                return restore_numbers(protected, lex_restore)
            protected, restore = protect_numbers(protected)
            restore |= lex_restore
            target = gender_to_speaker(get_caller_gender())
            pointed = g2p.vocalize(protected, speaker=persona_speaker, target_speaker=target)
            pointed = restore_numbers(pointed, restore)
        except Exception:  # noqa: BLE001 - niqqud must never break audio
            logger.warning("Niqqud transform failed; using unmodified text")
            return text
        if pointed != text:
            logger.debug("Hebrew niqqud transform applied")
        return pointed

    return transform
