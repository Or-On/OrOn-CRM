"""Authored pronunciations must survive the G2P and reach TTS.

A prompt rule cannot fix this: the scripted `say` lines never go through the
model, and the G2P re-points whatever it is given — which is how "אלי" came out
as "Ili" instead of "Eli" on a live call on 2026-07-26.
"""

import asyncio

from oron_hebrew.niqqud import make_hebrew_niqqud_transformer

ELI = {"אלי כהן": "אֵלִי כֹּהֵן"}
PLACEHOLDERS = ("", "")


class _EchoG2P:
    """Returns its input unchanged, so anything pointed in the output can only
    have come from the authored lexicon rather than from the model."""

    def vocalize(self, text: str, speaker=None, target_speaker=None) -> str:
        return text


class _ManglingG2P:
    """Re-points the name the way the real G2P does. Proves the protection, not
    just the substitution — without it this is what a caller hears."""

    def vocalize(self, text: str, speaker=None, target_speaker=None) -> str:
        return text.replace("אלי", "אִלִי")


def _run(g2p, text: str, lexicon=ELI) -> str:
    transform = make_hebrew_niqqud_transformer(g2p, lambda: None, "male", lexicon)
    return asyncio.run(transform(text, None))


def test_the_authored_form_reaches_tts():
    out = _run(_EchoG2P(), "שלום, שמי אור ממטה הבחירות של השר אלי כהן.")

    assert "אֵלִי כֹּהֵן" in out


def test_the_g2p_cannot_repoint_an_authored_name():
    """The actual bug: the G2P had the final say and turned Eli into Ili."""
    out = _run(_ManglingG2P(), "תשקול לתת את קולך לשר אלי כהן?")

    assert "אֵלִי כֹּהֵן" in out
    assert "אִלִי" not in out


def test_no_placeholder_ever_reaches_tts():
    """A leaked placeholder is a private-use character the voice would try to
    pronounce, which is worse than the mispronunciation it replaced."""
    out = _run(_ManglingG2P(), "השר אלי כהן, וגם אלי כהן שוב.")

    assert not any(p in out for p in PLACEHOLDERS)


def test_text_without_any_authored_term_is_untouched():
    line = "אין כאן שום שם מיוחד."

    assert _run(_EchoG2P(), line) == line


def test_an_empty_lexicon_is_a_no_op():
    line = "השר אלי כהן."

    assert _run(_EchoG2P(), line, {}) == line
