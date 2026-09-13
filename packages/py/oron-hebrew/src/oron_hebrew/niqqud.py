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
from itertools import islice

from loguru import logger
from renikud_onnx import G2P

from oron_hebrew.g2p import gender_to_speaker
from oron_hebrew.numbers import _PH_CLOSE, _PH_OPEN, protect_numbers, restore_numbers
from oron_hebrew.pronunciation import is_safe_pronunciation_pair

_HEBREW_LETTER_RE = re.compile(r"[א-ת]")

# These forms are ambiguous only because ordinary Hebrew omits vowels. They are
# deliberately much narrower than full-text automatic niqqud: every entry is a
# direct second-person form whose pronunciation is determined by the explicit
# caller-address choice. This fixes cases such as ``לך`` (lekha/lakh) and
# ``ניסית`` (nisita/nisit) without reintroducing the global pointing pass that
# previously damaged otherwise-natural Soniox Hebrew.
_CALLER_ADDRESS_NIQQUD: dict[str, dict[str, str]] = {
    "male": {
        "בשבילך": "בִּשְׁבִילְךָ",
        "שלומך": "שְׁלוֹמְךָ",
        "אצלך": "אֶצְלְךָ",
        "אליך": "אֵלֶיךָ",
        "עליך": "עָלֶיךָ",
        "עבורך": "עֲבוּרְךָ",
        "איתך": "אִתְּךָ",
        "אותך": "אוֹתְךָ",
        "ממך": "מִמְּךָ",
        "שלך": "שֶׁלְּךָ",
        "ניסית": "נִסִּיתָ",
        "ביקשת": "בִּקַּשְׁתָּ",
        "אמרת": "אָמַרְתָּ",
        "מסרת": "מָסַרְתָּ",
        "ציינת": "צִיַּנְתָּ",
        "עדכנת": "עִדְכַּנְתָּ",
        "בדקת": "בָּדַקְתָּ",
        "קיבלת": "קִבַּלְתָּ",
        "הצלחת": "הִצְלַחְתָּ",
        "התחברת": "הִתְחַבַּרְתָּ",
        "שלחת": "שָׁלַחְתָּ",
        "רצית": "רָצִיתָ",
        "עשית": "עָשִׂיתָ",
        "פנית": "פָּנִיתָ",
        "לך": "לְךָ",
    },
    "female": {
        "בשבילך": "בִּשְׁבִילֵךְ",
        "שלומך": "שְׁלוֹמֵךְ",
        "אצלך": "אֶצְלֵךְ",
        "אליך": "אֵלַיִךְ",
        "עליך": "עָלַיִךְ",
        "עבורך": "עֲבוּרֵךְ",
        "איתך": "אִתָּךְ",
        "אותך": "אוֹתָךְ",
        "ממך": "מִמֵּךְ",
        "שלך": "שֶׁלָּךְ",
        "ניסית": "נִסִּיתְ",
        "ביקשת": "בִּקַּשְׁתְּ",
        "אמרת": "אָמַרְתְּ",
        "מסרת": "מָסַרְתְּ",
        "ציינת": "צִיַּנְתְּ",
        "עדכנת": "עִדְכַּנְתְּ",
        "בדקת": "בָּדַקְתְּ",
        "קיבלת": "קִבַּלְתְּ",
        "הצלחת": "הִצְלַחְתְּ",
        "התחברת": "הִתְחַבַּרְתְּ",
        "שלחת": "שָׁלַחְתְּ",
        "רצית": "רָצִית",
        "עשית": "עָשִׂית",
        "פנית": "פָּנִית",
        "לך": "לָךְ",
    },
}
_ATTACHED_SPEECH_PREFIX = r"(?P<prefix>(?:וכש|כש|וש|ש|ו)?)"
_QUOTED_SPEECH = re.compile(r'("[^"\n]*"|“[^”\n]*”|«[^»\n]*»)')


def point_caller_address(text: str, gender: str | None) -> str:
    """Point only pronunciation-ambiguous direct address forms."""

    if _QUOTED_SPEECH.search(text):
        return "".join(
            part if index % 2 else point_caller_address(part, gender)
            for index, part in enumerate(_QUOTED_SPEECH.split(text))
        )
    forms = _CALLER_ADDRESS_NIQQUD.get(gender or "")
    if forms is None:
        return text
    for written, spoken in sorted(forms.items(), key=lambda item: len(item[0]), reverse=True):
        pattern = re.compile(rf"(?<![א-ת]){_ATTACHED_SPEECH_PREFIX}{re.escape(written)}(?![א-ת])")
        text = pattern.sub(lambda match, spoken=spoken: f"{match.group('prefix')}{spoken}", text)
    return text


def _protect_lexicon(text: str, lexicon: dict[str, str]) -> tuple[str, dict[str, str]]:
    """Swap authored spoken forms out of reach of the G2P.

    The same private-use placeholders the number rules use: the G2P passes them
    through, so the authored pointing is what reaches TTS. Without this the model
    re-points the word and a name like אלי comes back as "Ili" instead of "Eli",
    which no prompt instruction can fix — the scripted `say` lines never go
    through the model at all.
    """
    restore: dict[str, str] = {}
    for i, (written, spoken) in enumerate(
        sorted(islice(lexicon.items(), 64), key=lambda item: len(item[0]), reverse=True)
    ):
        if not is_safe_pronunciation_pair(written, spoken):
            continue
        if written and written in text:
            ph = f"{_PH_OPEN}L{i}{_PH_CLOSE}"
            pattern = re.compile(
                rf"(?<![\w\u0591-\u05c7]){re.escape(written)}(?![\w\u0591-\u05c7])"
            )
            text, count = pattern.subn(lambda _match, ph=ph: ph, text)
            if count:
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
                addressed = point_caller_address(protected, get_caller_gender())
                return restore_numbers(addressed, lex_restore)
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
