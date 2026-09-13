from oron_agent.audio import ResponsiveUserTurnStartStrategy
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InterimTranscriptionFrame,
    VADUserStartedSpeakingFrame,
)
from pipecat.turns.types import ProcessFrameResult


async def test_vad_interrupts_immediately_only_while_bot_is_speaking(monkeypatch):
    strategy = ResponsiveUserTurnStartStrategy()
    starts: list[bool] = []

    async def started(**_kwargs):
        starts.append(True)

    monkeypatch.setattr(strategy, "trigger_user_turn_started", started)

    assert (
        await strategy.process_frame(VADUserStartedSpeakingFrame()) is ProcessFrameResult.CONTINUE
    )
    await strategy.process_frame(BotStartedSpeakingFrame())
    assert await strategy.process_frame(VADUserStartedSpeakingFrame()) is ProcessFrameResult.STOP
    assert starts == [True]


async def test_transcript_starts_an_ordinary_turn_without_vad_noise(monkeypatch):
    strategy = ResponsiveUserTurnStartStrategy()
    starts: list[bool] = []

    async def started(**_kwargs):
        starts.append(True)

    monkeypatch.setattr(strategy, "trigger_user_turn_started", started)
    await strategy.process_frame(BotStoppedSpeakingFrame())

    result = await strategy.process_frame(
        InterimTranscriptionFrame(text="שלום", user_id="caller", timestamp="")
    )

    assert result is ProcessFrameResult.STOP
    assert starts == [True]
