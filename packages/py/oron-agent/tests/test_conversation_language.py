import pytest
from oron_agent.conversation_language import (
    CallerLanguageContextProcessor,
    ConversationLanguage,
    ConversationLanguageState,
    ResponseLanguageTTSProcessor,
    detect_conversation_language,
    resolve_conversation_language,
)
from pipecat.frames.frames import (
    AggregatedTextFrame,
    LLMMessagesAppendFrame,
    TranscriptionFrame,
    TTSUpdateSettingsFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.transcriptions.language import Language
from pipecat.utils.text.base_text_aggregator import AggregationType


@pytest.mark.parametrize(
    ("text", "provider", "expected"),
    [
        ("אני צריך עזרה", None, ConversationLanguage.HEBREW),
        ("I need help", None, ConversationLanguage.ENGLISH),
        (
            "לא עובד https://support.example.com/products/router/setup/troubleshooting",
            None,
            ConversationLanguage.HEBREW,
        ),
        ("המסך מציג ERR-502 ומבקש לנסות שוב", None, ConversationLanguage.HEBREW),
        ("Please email person@example.com", None, ConversationLanguage.ENGLISH),
        ("WhatsApp לא עובד", Language.HE, ConversationLanguage.HEBREW),
        ("OK", Language.EN, ConversationLanguage.ENGLISH),
        ("1234", None, None),
    ],
)
def test_language_detection_uses_script_then_provider(text, provider, expected):
    assert detect_conversation_language(text, provider) is expected


@pytest.mark.parametrize(
    ("text", "fallback", "expected"),
    [
        ("Can you help me?", "he-IL", ConversationLanguage.ENGLISH),
        ("אפשר לעזור לי?", "en-US", ConversationLanguage.HEBREW),
        ("1234", "he-IL", ConversationLanguage.HEBREW),
        ("...", "en-US", ConversationLanguage.ENGLISH),
    ],
)
def test_turn_language_uses_authored_fallback_only_for_ambiguous_text(text, fallback, expected):
    assert resolve_conversation_language(text, fallback) is expected


@pytest.mark.asyncio
async def test_language_switch_reaches_context_before_transcription(monkeypatch):
    state = ConversationLanguageState("he")
    processor = CallerLanguageContextProcessor(state)
    pushed = []

    async def capture(frame, direction):
        pushed.append((frame, direction))

    monkeypatch.setattr(processor, "push_frame", capture)
    transcript = TranscriptionFrame("Can you help me?", "caller", "", Language.EN)
    await processor.process_frame(transcript, FrameDirection.DOWNSTREAM)

    assert state.current is ConversationLanguage.ENGLISH
    assert isinstance(pushed[0][0], LLMMessagesAppendFrame)
    assert pushed[0][0].run_llm is False
    assert "respond entirely" in pushed[0][0].messages[0]["content"]
    assert pushed[1][0] is transcript


@pytest.mark.asyncio
async def test_tts_language_switch_precedes_spoken_frame(monkeypatch):
    state = ConversationLanguageState("he")
    state.current = ConversationLanguage.ENGLISH
    processor = ResponseLanguageTTSProcessor(state)
    pushed = []

    async def capture(frame, direction):
        pushed.append((frame, direction))

    monkeypatch.setattr(processor, "push_frame", capture)
    spoken = AggregatedTextFrame("How can I help?", AggregationType.SENTENCE)
    await processor.process_frame(spoken, FrameDirection.DOWNSTREAM)

    assert isinstance(pushed[0][0], TTSUpdateSettingsFrame)
    assert pushed[0][0].settings["language"] == Language.EN_US
    assert pushed[1][0] is spoken


@pytest.mark.asyncio
async def test_tts_does_not_repeat_same_language_setting(monkeypatch):
    state = ConversationLanguageState("en")
    processor = ResponseLanguageTTSProcessor(state)
    pushed = []

    async def capture(frame, direction):
        pushed.append(frame)

    monkeypatch.setattr(processor, "push_frame", capture)
    spoken = AggregatedTextFrame("Still English.", AggregationType.SENTENCE)
    await processor.process_frame(spoken, FrameDirection.DOWNSTREAM)

    assert pushed == [spoken]
