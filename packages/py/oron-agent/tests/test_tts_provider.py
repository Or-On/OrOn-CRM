"""The TTS provider swap must not drop the Hebrew path.

Both vendors get the same filters and the same niqqud transformer, and each maps
the language itself — Gemini wants "he-IL", Soniox "he". A provider switch that
silently loses one of these produces audio that sounds fine in English and reads
Hebrew wrong, which no unit test elsewhere would catch.
"""

import asyncio

import pytest
from google.auth.credentials import AnonymousCredentials
from oron_agent.bot import _flow_voice_for
from oron_agent.config import Settings
from oron_agent.language import language_profile
from oron_agent.tts import TtsProvider, build_tts
from oron_flows import FlowVoice
from oron_hebrew.filters import HebrewNormalizeFilter
from pipecat.services.google.tts import GeminiTTSService
from pipecat.services.soniox.tts import SonioxTTSService
from pipecat.services.tts_service import TextAggregationMode
from pipecat.utils.text.markdown_text_filter import MarkdownTextFilter


def _build(
    provider: TtsProvider,
    voice: str,
    speed: float = 1.0,
    first_clause: bool = False,
    reduce_silence: bool = False,
):
    return build_tts(
        provider,
        language=language_profile("he").tts_language,
        voice=voice,
        text_filters=[MarkdownTextFilter(), HebrewNormalizeFilter()],
        text_aggregation_mode=TextAggregationMode.SENTENCE,
        # Off by default here: these assert vendor settings, not aggregation.
        first_clause=first_clause,
        speed=speed,
        reduce_silence=reduce_silence,
        soniox_api_key="sx",
        soniox_model="tts-rt-v2",
        gemini_model="gemini-3.1-flash-tts-preview",
        google_credentials_path=None,
    )


@pytest.fixture
def google_auth_stubbed(monkeypatch):
    """GeminiTTSService authenticates and opens a grpc channel at construction."""
    asyncio.set_event_loop(asyncio.new_event_loop())
    monkeypatch.setattr(
        "pipecat.services.google.tts.default",
        lambda **_: (AnonymousCredentials(), "test-project"),
    )


def test_soniox_is_built_with_hebrew_and_the_text_filters():
    tts = _build(TtsProvider.SONIOX, "Maya")

    assert isinstance(tts, SonioxTTSService)
    assert tts._settings.language == "he"
    assert tts._settings.voice == "Maya"
    assert any(isinstance(f, HebrewNormalizeFilter) for f in tts._text_filters)


def test_gemini_stays_selectable(google_auth_stubbed):
    tts = _build(TtsProvider.GEMINI, "Leda")

    assert isinstance(tts, GeminiTTSService)
    assert tts._settings.language == "he-IL"
    assert any(isinstance(f, HebrewNormalizeFilter) for f in tts._text_filters)


def test_the_niqqud_transformer_registers_on_the_soniox_service():
    """add_text_transformer is a base-class API, but bot.py calls it on whatever
    build_tts returned — so it has to hold for the new provider too."""
    tts = _build(TtsProvider.SONIOX, "Maya")

    async def _noop(text: str, _aggregation_type: object) -> str:
        return text

    tts.add_text_transformer(_noop)

    assert len(tts._text_transforms) == 1


def test_soniox_uses_the_proven_original_text_audio_path():
    """Use the path proven audible on real LiveKit/SIP calls.

    Character timestamps can make interrupted context more precise, but with
    the current Pipecat/Soniox combination they produced timestamp text while
    the entire outbound recording channel remained silent. Original text frames
    also keep any optional niqqud out of the assistant's conversation memory.

    Re-asserted against pipecat 1.11.0, whose `_build_config_msg` still turns
    timestamps on unconditionally — so the override is load-bearing, not
    leftover.
    """
    tts = _build(TtsProvider.SONIOX, "Maya")

    assert tts._push_text_frames is True
    assert tts._build_config_msg("ctx-1")["return_timestamps"] is False
    # The unpatched service asks for timestamps: without the override this
    # service would take the path that went silent on a live call.
    assert SonioxTTSService._build_config_msg(tts, "ctx-1")["return_timestamps"] is True

    # Both defaults on together, which is how production runs: the guard is a
    # service-level flag, so swapping the aggregator must not reach it.
    with_clause = _build(TtsProvider.SONIOX, "Maya", first_clause=True)

    assert with_clause._push_text_frames is True
    assert with_clause._build_config_msg("ctx-1")["return_timestamps"] is False


def test_reduce_silence_is_absent_unless_a_deployment_asks_for_it():
    """Soniox errors on the field for a model without silence reduction, and
    documents `false` as the default — so sending `false` can only ever fail a
    stream. Absent means absent, not present-and-false."""
    assert "reduce_silence" not in _build(TtsProvider.SONIOX, "Maya")._build_config_msg("c")

    enabled = _build(TtsProvider.SONIOX, "Maya", reduce_silence=True)

    assert enabled._build_config_msg("c")["reduce_silence"] is True


def test_reduce_silence_is_a_soniox_only_knob(google_auth_stubbed):
    """Gemini has no equivalent; asking for one must not become a spoken
    instruction the way `speed` does."""
    gemini = _build(TtsProvider.GEMINI, "Leda", reduce_silence=True)

    assert not gemini._settings.prompt


def test_the_voice_and_model_defaults_follow_the_provider(monkeypatch):
    """A Gemini voice name means nothing to Soniox: crossing them is a 400 on the
    first utterance of a live call."""
    for key, value in (
        ("LIVEKIT_URL", "ws://x"),
        ("LIVEKIT_API_KEY", "k"),
        ("LIVEKIT_API_SECRET", "s"),
        ("GOOGLE_CLOUD_PROJECT", "p"),
        ("SONIOX_API_KEY", "sx"),
    ):
        monkeypatch.setenv(key, value)

    soniox = Settings(tts_provider=TtsProvider.SONIOX)
    gemini = Settings(tts_provider=TtsProvider.GEMINI)

    assert (soniox.tts_voice_default, soniox.tts_model) == (
        soniox.soniox_tts_voice_default,
        soniox.soniox_tts_model,
    )
    assert (gemini.tts_voice_default, gemini.tts_model) == (
        gemini.gemini_tts_voice_default,
        gemini.gemini_tts_model,
    )
    assert soniox.tts_voice_default != gemini.tts_voice_default


def test_speed_reaches_each_vendor_in_the_form_it_understands(google_auth_stubbed):
    """Soniox takes a multiplier; Gemini's TTS model takes none at all and is
    directed in words. A knob that lands on neither silently does nothing."""
    assert _build(TtsProvider.SONIOX, "Maya", speed=1.2)._settings.speed == 1.2
    assert "1.2x" in _build(TtsProvider.GEMINI, "Leda", speed=1.2)._settings.prompt


def test_the_default_pace_adds_no_instruction(google_auth_stubbed):
    """1.0 is the vendor's own pace, so it must not spend prompt on saying so."""
    assert not _build(TtsProvider.GEMINI, "Leda")._settings.prompt


def test_a_flows_voice_is_dropped_when_the_provider_is_overridden():
    """Voice names are per-vendor namespaces. A flow that names {gemini, Leda},
    A/B'd from the console with tts_provider=soniox, must not send "Leda" to
    Soniox — that is a 400 on the first utterance of a live call."""
    flow = FlowVoice(tts_provider=TtsProvider.GEMINI, tts_voice="Leda")

    assert _flow_voice_for(flow, TtsProvider.GEMINI) == "Leda"
    assert _flow_voice_for(flow, TtsProvider.SONIOX) is None
    # A flow that names only a voice trusts whatever provider is deployed.
    assert _flow_voice_for(FlowVoice(tts_voice="Maya"), TtsProvider.SONIOX) == "Maya"
