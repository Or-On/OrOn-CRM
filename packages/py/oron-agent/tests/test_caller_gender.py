import uuid

import pytest
from oron_agent.caller_gender import (
    CallerGender,
    CallerGenderContextProcessor,
    CallerGenderSource,
    CallerGenderState,
    apply_caller_gender_to_flow,
    caller_gender_instruction,
    detect_explicit_caller_gender,
)
from oron_flows import FlowSpec
from oron_flows.node import FlowNode, Message
from pipecat.frames.frames import LLMMessagesAppendFrame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection


@pytest.mark.parametrize(
    "text",
    [
        "רק שאני גבר, לא אישה",
        "אני זכר",
        "אני בחור",
        "דברי אליי בלשון זכר",
        "תפנה אליי בלשון זכרית בבקשה",
        "דברו איתי בלשון זכר",
        "אני יכול לדבר עכשיו",
        "אני צריך עזרה",
        "אני מעוניין לשמוע עוד",
    ],
)
def test_detects_explicit_male_self_identification(text):
    assert detect_explicit_caller_gender(text) is CallerGender.MALE


@pytest.mark.parametrize(
    "text",
    [
        "אני אישה",
        "אני נקבה",
        "אני בחורה",
        "דבר אליי בלשון נקבה",
        "תפני אליי בלשון נקבית בבקשה",
        "תדברו אלי בלשון נקבה",
        "אני יכולה לדבר עכשיו",
        "אני צריכה עזרה",
        "אני מעוניינת לשמוע עוד",
    ],
)
def test_detects_explicit_female_self_identification(text):
    assert detect_explicit_caller_gender(text) is CallerGender.FEMALE


@pytest.mark.parametrize(
    "text",
    [
        "יש לי בן",
        "האישה ביקשה שאחזור אליה",
        "אני מדבר בשם גבר אחר",
        "הלקוחה היא אישה",
        "לא בטוח",
    ],
)
def test_does_not_guess_from_third_party_or_ambiguous_language(text):
    assert detect_explicit_caller_gender(text) is None


def test_explicit_declaration_overrides_and_locks_acoustic_guess():
    state = CallerGenderState()

    assert state.observe_acoustic("female") is CallerGender.FEMALE
    assert state.observe_transcript("רק שאני גבר, לא אישה") is CallerGender.MALE
    assert state.source is CallerGenderSource.EXPLICIT
    assert state.tts_value == "male"
    assert state.observe_acoustic("female") is None
    assert state.tts_value == "male"


def test_configured_address_form_is_stable_but_caller_can_correct_it():
    state = CallerGenderState(CallerGender.MALE)

    assert state.source is CallerGenderSource.CONFIGURED
    assert state.observe_acoustic("female") is None
    assert state.tts_value == "male"
    assert state.observe_transcript("אני אישה") is CallerGender.FEMALE
    assert state.source is CallerGenderSource.EXPLICIT
    assert state.tts_value == "female"


def test_repeated_explicit_declaration_does_not_duplicate_context_update():
    state = CallerGenderState()

    assert state.observe_transcript("אני גבר") is CallerGender.MALE
    assert state.observe_transcript("כבר אמרתי, אני גבר") is None


def test_instruction_requires_natural_correction_and_consistent_forms():
    instruction = caller_gender_instruction(CallerGender.MALE, explicit=True)

    assert "authoritative" in instruction
    assert "אתה" in instruction
    assert "סליחה, טעיתי" in instruction
    assert "Never say 'סליחה רבה'" in instruction


def test_configured_instruction_is_authoritative_without_claiming_audio_detection():
    instruction = caller_gender_instruction(CallerGender.FEMALE, explicit=False, configured=True)

    assert "selected for this call" in instruction
    assert "Use feminine Hebrew" in instruction
    assert "acoustic" not in instruction


def test_configured_male_form_distinguishes_female_agent_from_male_caller():
    instruction = caller_gender_instruction(
        CallerGender.MALE,
        explicit=False,
        configured=True,
        persona_gender="female",
    )

    assert "Use masculine Hebrew" in instruction
    assert "Never address him as את, תוכלי" in instruction
    assert "אני מבינה" in instruction


def test_selected_address_form_is_added_to_primary_flow_and_node_system_roles():
    spec = FlowSpec(
        id=uuid.uuid4(),
        version=1,
        entry="start",
        role_message="Female agent persona",
        nodes=[
            FlowNode(
                name="start",
                role_message="Node-specific role",
                task_messages=[Message(content="start")],
            ),
        ],
    )

    configured = apply_caller_gender_to_flow(spec, CallerGender.MALE)

    assert "Female agent persona" in configured.role_message
    assert "Use masculine Hebrew" in configured.role_message
    assert "Node-specific role" in configured.nodes[0].role_message
    assert "Use masculine Hebrew" in configured.nodes[0].role_message


@pytest.mark.asyncio
async def test_context_update_precedes_the_transcription_that_triggers_inference(monkeypatch):
    processor = CallerGenderContextProcessor(CallerGenderState(), session_id="test-session")
    pushed = []

    async def capture(frame, direction):
        pushed.append((frame, direction))

    monkeypatch.setattr(processor, "push_frame", capture)
    transcript = TranscriptionFrame(
        text="רק שאני גבר, לא אישה",
        user_id="caller",
        timestamp="",
    )

    await processor.process_frame(transcript, FrameDirection.DOWNSTREAM)

    assert isinstance(pushed[0][0], LLMMessagesAppendFrame)
    assert pushed[0][0].run_llm is False
    assert "Use masculine Hebrew" in pushed[0][0].messages[0]["content"]
    assert pushed[1] == (transcript, FrameDirection.DOWNSTREAM)


@pytest.mark.parametrize(
    "text",
    [
        'היא אמרה "אני גבר"',
        'הוא ביקש: "דברי אליי בלשון זכר"',
        "אל תדברי אליי בלשון זכר",
        "לא תפני אליי בלשון נקבה",
        "אני לא גבר",
        "אשתי צריכה עזרה",
        "הוא אמר שאני גבר",
        "אני גבר ואני אישה",
        "אם אני גבר",
        "אני לא רוצה שתדברי אליי בלשון זכר",
        "Don't address me in feminine language",
    ],
)
def test_quoted_negated_reported_and_conflicting_forms_do_not_set_preference(text):
    assert detect_explicit_caller_gender(text) is None


@pytest.mark.parametrize(
    "text",
    ["דברי אליי בלשון ניטרלית", "פנה אליי ללא מגדר", "אני מעדיפה פנייה ניטרלית"],
)
def test_explicit_neutral_preference(text):
    assert detect_explicit_caller_gender(text) is CallerGender.NEUTRAL


def test_clear_self_correction_selects_latest_form():
    assert detect_explicit_caller_gender("אני גבר, בעצם אני אישה") is CallerGender.FEMALE


def test_direct_preference_is_stronger_than_first_person_grammar():
    assert (
        detect_explicit_caller_gender("אני צריך עזרה, דברי אליי בלשון נקבה") is CallerGender.FEMALE
    )
    assert (
        detect_explicit_caller_gender("Please address me in neutral language")
        is CallerGender.NEUTRAL
    )


def test_unknown_is_neutral_and_does_not_claim_identity():
    instruction = caller_gender_instruction(CallerGender.UNKNOWN, explicit=False, configured=True)
    assert "naturally neutral" in instruction
    assert "does not establish biological sex" in instruction
    assert "later caller correction" in instruction


def test_caller_can_clear_an_old_preference_without_affecting_unrelated_preferences():
    state = CallerGenderState(CallerGender.MALE)
    assert state.observe_transcript("אין לי העדפה לגבי לשון הפנייה") is CallerGender.UNKNOWN
    assert state.observe_transcript("אין לי העדפה לגבי היום") is None
    assert detect_explicit_caller_gender("אני מעדיפה לשון נקבה") is CallerGender.FEMALE


@pytest.mark.asyncio
async def test_later_accepted_segment_overrides_operator_and_earlier_correction(monkeypatch):
    state = CallerGenderState(CallerGender.FEMALE)
    processor = CallerGenderContextProcessor(state, session_id="fixture")
    pushed = []

    async def capture(frame, direction):
        pushed.append(frame)

    monkeypatch.setattr(processor, "push_frame", capture)
    for text in ["דברי אליי בלשון זכר", "דברי אליי בלשון ניטרלית"]:
        await processor.process_frame(
            TranscriptionFrame(text, "fixture", "", finalized=True), FrameDirection.DOWNSTREAM
        )
    assert state.gender is CallerGender.NEUTRAL
    assert len([frame for frame in pushed if isinstance(frame, LLMMessagesAppendFrame)]) == 2
