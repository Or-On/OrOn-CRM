"""Integration coverage for the Hebrew wiring, standing in for the live-mic
LiveKit-playground gate (which needs a human). These build the REAL objects
bot.py builds — a real GeminiTTSService (no network call at construction, though
it does resolve credentials, which the test stubs) and a real G2P — and assert:

1. the TTS service carries the normalize filter + a registered niqqud
   text-transformer, exactly as bot.py wires it;
2. caller gender changes the pointed output for a real gendered homograph
   ("מה שלומך" — shlomkha/shlomekh), which is the caller-gender ->
   pointed-Hebrew effect the live gate is meant to confirm by ear.

The G2P is deliberately absent from the input path: it exists only to point
the LLM's Hebrew on the way out to TTS.
"""

import asyncio

from google.auth.credentials import AnonymousCredentials
from oron_hebrew import build_g2p, make_hebrew_niqqud_transformer
from oron_hebrew.filters import HebrewNormalizeFilter
from pipecat.services.google.tts import GeminiTTSService


def _build_wired_tts(g2p, get_caller_gender) -> GeminiTTSService:
    """Same wiring bot.py performs in run_bot(): filter passed at construction
    (TTSService only exposes a private _text_filters, no public setter),
    transformer registered via add_text_transformer()."""
    tts = GeminiTTSService(
        credentials_path=None,
        location=None,
        text_filters=[HebrewNormalizeFilter()],
        settings=GeminiTTSService.Settings(
            model="gemini-2.5-flash-tts", voice="Kore", language="he-IL"
        ),
    )
    tts.add_text_transformer(make_hebrew_niqqud_transformer(g2p, get_caller_gender))
    return tts


def test_tts_has_normalize_filter_and_niqqud_transformer_registered(monkeypatch):
    # GeminiTTSService builds a grpc async channel at construction, which needs a
    # live event loop. A prior async test in the suite can leave the default loop
    # closed, so give this sync test a fresh current loop. (bot.py builds the TTS
    # inside run_bot's running loop, so this is a test-harness concern only.)
    asyncio.set_event_loop(asyncio.new_event_loop())

    # Construction also authenticates: given no credentials argument pipecat falls
    # back to application-default credentials and raises when there are none, so
    # this passed only on a machine that happened to have gcloud set up and failed
    # in CI. Anonymous credentials let the client be built anywhere — the
    # assertions below only inspect local wiring, and none of this calls out.
    monkeypatch.setattr(
        "pipecat.services.google.tts.default",
        lambda **_: (AnonymousCredentials(), "test-project"),
    )

    tts = _build_wired_tts(build_g2p(), lambda: None)

    assert any(isinstance(f, HebrewNormalizeFilter) for f in tts._text_filters)
    assert len(tts._text_transforms) == 1
    agg_type, _fn = tts._text_transforms[0]
    assert agg_type == "*"


async def test_caller_gender_changes_pointed_output():
    """The whole point of tracking caller gender: male vs female callers must
    get different pointed Hebrew for a genuinely gendered homograph."""

    class _GenderFixtureG2P:
        def vocalize(self, _text, *, target_speaker=0, **_kwargs):
            return "מַה שׁלוֹמךַ" if target_speaker == 1 else "מַה שׁלוֹמֶך"

    g2p = _GenderFixtureG2P()

    male_transform = make_hebrew_niqqud_transformer(g2p, lambda: "male")
    female_transform = make_hebrew_niqqud_transformer(g2p, lambda: "female")

    homograph = "מה שלומך"  # shlomkha (male) vs shlomekh (female) — real homograph
    male_pointed = await male_transform(homograph, "*")
    female_pointed = await female_transform(homograph, "*")

    assert male_pointed != female_pointed, (
        "gendered homograph must be pointed differently for male vs. female "
        f"caller: got {male_pointed!r} == {female_pointed!r}"
    )
    # Guard the exact forms so a future renikud/model upgrade that silently drops
    # gender-conditioning trips this test, not just an inequality check.
    assert male_pointed == "מַה שׁלוֹמךַ"
    assert female_pointed == "מַה שׁלוֹמֶך"
