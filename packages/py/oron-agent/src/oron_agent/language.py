from enum import StrEnum

from loguru import logger
from pipecat.transcriptions.language import Language
from pydantic import BaseModel


class SupportedLanguage(StrEnum):
    he = "he"
    en = "en"


class LanguageProfile(BaseModel):
    # Language is itself a StrEnum, so Pydantic validates list[Language] natively.
    stt_hints: list[Language]
    # A Language, not a vendor string: Gemini wants "he-IL" and Soniox "he", and
    # each pipecat service maps the enum itself.
    tts_language: Language
    idle_prompts: list[str]
    """What to say to a caller who has gone quiet, in order. Spoken verbatim, so
    it is localised copy and lives here rather than in the pipeline code. The
    LAST entry is the sign-off; the call ends one interval after it is spoken."""


def language_profile(language: str) -> LanguageProfile:
    """Resolve a flow language code to STT/TTS engine settings.

    Unknown codes fall back to Hebrew (the platform default) with a warning.
    """
    profiles: dict[SupportedLanguage, LanguageProfile] = {
        SupportedLanguage.he: LanguageProfile(
            # Soniox v5 can identify language within one stream. Bias toward the
            # authored language first while allowing a caller to switch naturally.
            stt_hints=[Language.HE, Language.EN],
            tts_language=Language.HE_IL,
            idle_prompts=[
                "הלו, אתם עדיין איתי?",
                "אני עדיין כאן. אם אתם צריכים משהו, אפשר לדבר.",
                # Gender-neutral first person: the persona may be female or male.
                "לא שמעתי כלום, אז אסיים כאן את השיחה. תודה ולהתראות.",
            ],
        ),
        SupportedLanguage.en: LanguageProfile(
            stt_hints=[Language.EN, Language.HE],
            tts_language=Language.EN_US,
            idle_prompts=[
                "Hello, are you still there?",
                "I'm still here — just say the word if you need anything.",
                "I haven't heard anything, so I'll end the call here. Goodbye.",
            ],
        ),
    }
    try:
        key = SupportedLanguage(language)
    except ValueError:
        logger.warning(f"unsupported flow language '{language}'; defaulting to Hebrew")
        key = SupportedLanguage.he
    return profiles[key]
