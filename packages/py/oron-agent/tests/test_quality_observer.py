import json

import pytest
from oron_agent.quality_observer import VoiceQualityObserver
from pipecat.frames.frames import (
    AggregatedTextFrame,
    BotStartedSpeakingFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMTextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.utils.text.base_text_aggregator import AggregationType


@pytest.mark.asyncio
async def test_real_frame_stage_observations_are_private_and_do_not_claim_playback():
    llm, tts, transport, middle = [FrameProcessor() for _ in range(4)]
    observer = VoiceQualityObserver(llm=llm, tts=tts, transport_output=transport)

    async def push(frame, ms, source=middle, destination=middle):
        await observer.on_push_frame(
            FramePushed(source, destination, frame, FrameDirection.DOWNSTREAM, int(ms * 1_000_000))
        )

    await push(UserStoppedSpeakingFrame(), 100)
    accepted = TranscriptionFrame("secret fictional customer detail", "fixture", "", finalized=True)
    accepted.metadata["recognition_state"] = "accepted"
    await push(accepted, 120)
    await push(accepted, 130)
    await push(LLMContextFrame(LLMContext()), 140, destination=llm)
    await push(LLMTextFrame("secret text"), 200, source=llm)
    planned = AggregatedTextFrame("private reply", AggregationType.SENTENCE)
    planned.metadata["voice_generation"] = 1
    await push(planned, 250)
    planned.metadata["grounding"] = {"private_document": "do not retain"}
    await push(planned, 260)
    audio = TTSAudioRawFrame(b"\x00\x00", 24000, 1, context_id="private-id")
    await push(audio, 300, source=tts)
    await push(audio, 320, destination=transport)
    await push(BotStartedSpeakingFrame(), 340, source=transport)
    await push(InterruptionFrame(), 350)
    await push(audio, 360, source=tts)

    result = observer.finalize()
    turn = result["turns"][0]
    assert turn["durations_ms"]["speech_end_to_accepted_ms"] == 20
    assert turn["durations_ms"]["model_first_token_ms"] == 60
    assert turn["durations_ms"]["validation_ms"] == 10
    assert turn["generated"] and turn["synthesized"] and turn["submitted_to_transport"]
    assert turn["exact_playback_confirmed"] is False
    assert turn["playback"] == "partial_or_unknown"
    assert result["summary_ms"]["validation_ms"] == {"samples": 1, "p50": 10, "p95": 10}
    assert result["stale_audio_frames"] == 1
    serialized = json.dumps(result)
    assert (
        "secret" not in serialized and "private" not in serialized and "fixture" not in serialized
    )


@pytest.mark.asyncio
async def test_missing_stages_are_unknown_and_retention_is_bounded():
    llm, tts, transport = [FrameProcessor() for _ in range(3)]
    observer = VoiceQualityObserver(llm=llm, tts=tts, transport_output=transport, max_turns=2)
    for time_ms in range(5):
        await observer.on_push_frame(
            FramePushed(
                tts,
                llm,
                LLMContextFrame(LLMContext()),
                FrameDirection.DOWNSTREAM,
                time_ms * 1_000_000,
            )
        )
    result = observer.snapshot()
    assert result["retained_turns"] == 2
    assert result["total_turns"] == 5
    assert result["summary_ms"]["model_first_token_ms"] == {"samples": 0, "p50": None, "p95": None}
    assert all(not turn["exact_playback_confirmed"] for turn in result["turns"])
