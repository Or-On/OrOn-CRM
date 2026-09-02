from oron_agent.language import LanguageProfile, SupportedLanguage, language_profile
from pipecat.transcriptions.language import Language


def test_hebrew_profile():
    p = language_profile("he")
    assert isinstance(p, LanguageProfile)
    assert p.stt_hints == [Language.HE]
    assert p.tts_language == "he-IL"


def test_english_profile():
    p = language_profile("en")
    assert p.stt_hints == [Language.EN]
    assert p.tts_language == "en-US"


def test_unknown_language_falls_back_to_hebrew():
    p = language_profile("xx")
    assert p.stt_hints == [Language.HE]
    assert p.tts_language == "he-IL"


def test_supported_language_is_strenum():
    assert SupportedLanguage.he == "he"
    assert SupportedLanguage("en") is SupportedLanguage.en
