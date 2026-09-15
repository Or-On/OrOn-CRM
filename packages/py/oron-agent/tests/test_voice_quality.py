import pytest
from oron_agent.voice_quality import (
    PronunciationEntry,
    VoiceQualityConfig,
    build_soniox_context,
    make_speech_transformer,
)
from pipecat.services.soniox.stt import SonioxSTTService
from pydantic import ValidationError


def test_published_vocabulary_uses_installed_soniox_structured_terms():
    quality = VoiceQualityConfig(sttVocabulary=["ממיר", "HDMI", "hdmi"])
    context = build_soniox_context(quality)
    settings = SonioxSTTService.Settings(context=context)
    assert settings.context.model_dump(exclude_none=True) == {"terms": ["ממיר", "HDMI"]}
    assert build_soniox_context(VoiceQualityConfig()) is None


@pytest.mark.parametrize(
    "terms", [["x" * 81], ["term"] * 65, ["x" * 79 + str(i) for i in range(30)], ["<system>"]]
)
def test_vocabulary_is_bounded(terms):
    with pytest.raises(ValidationError):
        VoiceQualityConfig(sttVocabulary=terms)


@pytest.mark.parametrize(
    ("original", "spoken"),
    [
        ("150", "חמישים"),
        ("לא", "כן"),
        ("שולם", "שֻׁלַּם"),
        ("המחיר", "50 ₪"),
        ("שלום", "נשלח"),
        ("brand", "<phoneme>brand</phoneme>"),
        ("שלך", "שֶׁלְּךָ"),
        ("אלי", "ישראל"),
    ],
)
def test_dictionary_cannot_rewrite_critical_values_address_or_authorization(original, spoken):
    with pytest.raises(ValidationError):
        PronunciationEntry(original=original, spoken=spoken, language="he")


@pytest.mark.asyncio
async def test_speech_dictionary_preserves_canonical_text_and_whole_names():
    quality = VoiceQualityConfig(
        pronunciationDictionary=[
            PronunciationEntry(original="אלי", spoken="אֵלִי", language="he"),
            PronunciationEntry(original="OrOn", spoken="אוֹר אוֹן", language="he"),
        ]
    )
    transform = make_speech_transformer(quality, lambda: "neutral")
    canonical = "אלי ישראלי עובד עם OrOn"
    assert await transform(canonical, None) == "אֵלִי ישראלי עובד עם אוֹר אוֹן"
    assert canonical == "אלי ישראלי עובד עם OrOn"


@pytest.mark.asyncio
async def test_pronunciation_is_scoped_by_language_and_literal_context():
    quality = VoiceQualityConfig(
        pronunciationDictionary=[
            PronunciationEntry(original="ממיר", spoken="מֵמִיר", language="he", context="טלוויזיה"),
            PronunciationEntry(original="sample", spoken="example", language="en"),
        ]
    )
    transform = make_speech_transformer(quality, lambda: None)
    assert await transform("ממיר sample", None) == "ממיר sample"
    assert await transform("ממיר טלוויזיה", None) == "מֵמִיר טלוויזיה"


@pytest.mark.asyncio
async def test_english_configuration_does_not_expand_numbers_into_hebrew():
    transform = make_speech_transformer(VoiceQualityConfig(language="en"), lambda: None)
    assert await transform("The amount is 150.05", None) == "The amount is 150.05"


@pytest.mark.asyncio
async def test_dynamic_turn_language_scopes_pronunciation_and_preserves_caller_address():
    current_language = "en"
    quality = VoiceQualityConfig(
        language="en",
        pronunciationDictionary=[
            PronunciationEntry(original="sample", spoken="example", language="en"),
            PronunciationEntry(original="OrOn", spoken="אוֹר אוֹן", language="he"),
        ],
    )
    transform = make_speech_transformer(
        quality,
        lambda: "male",
        get_language=lambda: current_language,
    )

    assert await transform("sample", None) == "example"
    current_language = "he"
    assert await transform("את יכולה לבדוק OrOn?", None) == "אתה יכול לבדוק אוֹר אוֹן?"


def test_duplicate_pronunciations_fail_closed():
    entry = PronunciationEntry(original="אלי", spoken="אֵלִי", language="he")
    with pytest.raises(ValidationError):
        VoiceQualityConfig(pronunciationDictionary=[entry, entry])
