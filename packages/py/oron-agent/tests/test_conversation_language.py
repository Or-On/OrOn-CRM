import pytest
from oron_agent.conversation_language import (
    CallerLanguageContextProcessor,
    ConversationLanguageState,
    ResponseLanguageTTSProcessor,
    normalize_language,
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
    ("provider", "expected"),
    [
        (Language.HE, "he"),
        (Language.EN_US, "en"),
        (Language.FR, "fr"),
        ("es-MX", "es"),
        (None, None),
        ("unknown-language", None),
    ],
)
def test_language_comes_from_provider_metadata(provider, expected):
    assert normalize_language(provider) == expected


def test_transcript_script_never_changes_language_without_provider_metadata():
    state = ConversationLanguageState("he")
    assert not state.observe(TranscriptionFrame("This is English", "caller", "", None))
    assert state.current == "he"


@pytest.mark.asyncio
async def test_language_switch_reaches_context_before_transcription(monkeypatch):
    state = ConversationLanguageState("he")
    processor = CallerLanguageContextProcessor(state)
    pushed = []

    async def capture(frame, direction):
        pushed.append((frame, direction))

    monkeypatch.setattr(processor, "push_frame", capture)
    transcript = TranscriptionFrame("Bonjour", "caller", "", Language.FR, finalized=True)
    await processor.process_frame(transcript, FrameDirection.DOWNSTREAM)

    assert state.current == "fr"
    assert isinstance(pushed[0][0], LLMMessagesAppendFrame)
    assert pushed[0][0].run_llm is False
    instruction = pushed[0][0].messages[0]["content"]
    assert "language code 'fr'" in instruction
    assert "must not route, classify, reject, or replace" in instruction
    assert pushed[1][0] is transcript


@pytest.mark.asyncio
async def test_tts_primary_language_switch_precedes_spoken_frame(monkeypatch):
    state = ConversationLanguageState("he")
    state.current = "fr"
    processor = ResponseLanguageTTSProcessor(state)
    pushed = []

    async def capture(frame, direction):
        pushed.append((frame, direction))

    monkeypatch.setattr(processor, "push_frame", capture)
    spoken = AggregatedTextFrame("<lang:fr> Bonjour.", AggregationType.SENTENCE)
    await processor.process_frame(spoken, FrameDirection.DOWNSTREAM)

    assert isinstance(pushed[0][0], TTSUpdateSettingsFrame)
    assert pushed[0][0].settings["language"] == Language.FR
    assert pushed[1][0] is spoken
    assert spoken.text == "Bonjour."


@pytest.mark.asyncio
async def test_explicit_response_language_overrides_caller_language(monkeypatch):
    state = ConversationLanguageState("en")
    processor = ResponseLanguageTTSProcessor(state)
    pushed = []

    async def capture(frame, _direction):
        pushed.append(frame)

    monkeypatch.setattr(processor, "push_frame", capture)
    spoken = AggregatedTextFrame(
        "<lang:fr> Bien sûr, continuons en français.",
        AggregationType.SENTENCE,
    )
    await processor.process_frame(spoken, FrameDirection.DOWNSTREAM)

    assert isinstance(pushed[0], TTSUpdateSettingsFrame)
    assert pushed[0].settings["language"] == Language.FR
    assert pushed[1].text == "Bien sûr, continuons en français."


@pytest.mark.asyncio
async def test_tts_does_not_repeat_same_language_setting(monkeypatch):
    state = ConversationLanguageState("en")
    processor = ResponseLanguageTTSProcessor(state)
    pushed = []

    async def capture(frame, _direction):
        pushed.append(frame)

    monkeypatch.setattr(processor, "push_frame", capture)
    spoken = AggregatedTextFrame("Still English.", AggregationType.SENTENCE)
    await processor.process_frame(spoken, FrameDirection.DOWNSTREAM)

    assert pushed == [spoken]


@pytest.mark.asyncio
async def test_a_provisional_label_never_switches_the_conversation(monkeypatch):
    """Soniox revises its language guess while an utterance is still open. Only
    the endpointed utterance's dominant language is a decision; acting on a
    revision makes the agent flip language mid-sentence."""

    state = ConversationLanguageState("he")
    processor = CallerLanguageContextProcessor(state)
    pushed = []

    async def capture(frame, direction):
        pushed.append(frame)

    monkeypatch.setattr(processor, "push_frame", capture)
    await processor.process_frame(
        TranscriptionFrame("router", "caller", "", Language.EN_US, finalized=False),
        FrameDirection.DOWNSTREAM,
    )

    assert state.current == "he"
    assert not any(isinstance(frame, LLMMessagesAppendFrame) for frame in pushed)


@pytest.mark.asyncio
async def test_an_utterance_in_the_current_language_adds_no_instruction(monkeypatch):
    """One English product name inside a Hebrew sentence still endpoints as
    Hebrew, and a redundant metadata line every turn is prompt noise."""

    state = ConversationLanguageState("he")
    processor = CallerLanguageContextProcessor(state)
    pushed = []

    async def capture(frame, direction):
        pushed.append(frame)

    monkeypatch.setattr(processor, "push_frame", capture)
    await processor.process_frame(
        TranscriptionFrame("יש לי בעיה עם ה-router", "caller", "", Language.HE, finalized=True),
        FrameDirection.DOWNSTREAM,
    )

    assert state.current == "he"
    assert not any(isinstance(frame, LLMMessagesAppendFrame) for frame in pushed)


@pytest.mark.asyncio
async def test_a_short_answer_can_still_carry_the_switch_back(monkeypatch):
    """ "כן" is one word, but it is a complete endpointed utterance and the
    provider labels it — a caller who has switched back must be followed."""

    state = ConversationLanguageState("he")
    state.current = "en"
    processor = CallerLanguageContextProcessor(state)
    pushed = []

    async def capture(frame, direction):
        pushed.append(frame)

    monkeypatch.setattr(processor, "push_frame", capture)
    await processor.process_frame(
        TranscriptionFrame("כן", "caller", "", Language.HE, finalized=True),
        FrameDirection.DOWNSTREAM,
    )

    assert state.current == "he"
    instruction = next(f for f in pushed if isinstance(f, LLMMessagesAppendFrame))
    assert "language code 'he'" in instruction.messages[0]["content"]
