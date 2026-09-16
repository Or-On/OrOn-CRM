import json
import uuid

from oron_agent.text_diagnostics import VoiceTextDiagnostics, redact_voice_text


def test_voice_text_redaction_removes_identifier_shaped_digits() -> None:
    redacted = redact_voice_text("הטלפון 050-1234567 ותעודת הזהות 123456789")

    assert "050" not in redacted
    assert "123456789" not in redacted
    assert redacted.count("[redacted-number]") == 2


async def test_development_diagnostic_correlates_redacted_text_and_stage_latency(tmp_path) -> None:
    output = tmp_path / "voice-turns.json"
    diagnostics = VoiceTextDiagnostics(
        str(output),
        session_id=uuid.uuid4(),
        tenant_id=uuid.uuid4(),
        handoff_id=uuid.uuid4(),
        verification_state="identity_required",
    )
    diagnostics.record_stt("המספר שלי 123456789", "he")
    diagnostics.record_llm("תודה. המספר 123456789 התקבל.")
    diagnostics.record_tts("תודה, אפשר להמשיך?")
    diagnostics.set_verification_state("context_unlocked")

    await diagnostics.finalize(
        {
            "turns": [
                {
                    "turn_index": 1,
                    "durations_ms": {
                        "speech_end_to_accepted_ms": 120.0,
                        "model_first_token_ms": 340.0,
                        "validated_to_synthesis_ms": 210.0,
                    },
                }
            ]
        }
    )

    payload = json.loads(output.read_text(encoding="utf-8"))
    turn = payload["turns"][0]
    assert turn["stt_final_text"] == "המספר שלי [redacted-number]"
    assert turn["llm_response_text"] == "תודה. המספר [redacted-number] התקבל."
    assert turn["tts_input_text"] == "תודה, אפשר להמשיך?"
    assert turn["endpoint_latency"] == 120.0
    assert turn["context_unlock_state"] == "locked"


async def test_diagnostic_keeps_the_generated_call_opening_as_the_first_turn(tmp_path) -> None:
    output = tmp_path / "opening.json"
    diagnostics = VoiceTextDiagnostics(
        str(output),
        session_id=uuid.uuid4(),
        tenant_id=uuid.uuid4(),
        handoff_id=None,
        verification_state="context_unlocked",
    )
    diagnostics.record_tts("Welcome to tenant support.")
    diagnostics.record_llm("Welcome to tenant support.")
    diagnostics.record_stt("Hello", "en")
    diagnostics.record_tts("How can I help?")
    diagnostics.record_llm("How can I help?")

    await diagnostics.finalize({"turns": []})

    turns = json.loads(output.read_text(encoding="utf-8"))["turns"]
    assert [turn["turn_id"] for turn in turns] == [1, 2]
    assert turns[0]["stt_final_text"] is None
    assert turns[0]["tts_input_text"] == "Welcome to tenant support."
    assert turns[1]["stt_final_text"] == "Hello"
