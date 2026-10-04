import asyncio

import pytest
from oron_agent.memory_cadence import VoiceMemoryCapture


@pytest.mark.asyncio
async def test_final_turns_serialized_and_end_once():
    calls = []

    async def append(ordinal, text):
        await asyncio.sleep(0)
        calls.append((ordinal, text))

    async def finish():
        calls.append("end")

    capture = VoiceMemoryCapture(append, finish)
    await capture.final_turn("   ")
    await asyncio.gather(*(capture.final_turn(str(i)) for i in range(12)))
    await asyncio.gather(capture.finish(), capture.finish())
    assert calls == [(i + 1, str(i)) for i in range(12)] + ["end"]
    with pytest.raises(RuntimeError):
        await capture.final_turn("late")


@pytest.mark.asyncio
async def test_ambiguous_write_retries_same_ordinal_before_next_turn():
    calls = []

    async def append(ordinal, text):
        calls.append((ordinal, text))
        if len(calls) == 1:
            raise TimeoutError("ambiguous commit")

    async def finish():
        calls.append("end")

    capture = VoiceMemoryCapture(append, finish)
    with pytest.raises(TimeoutError):
        await capture.final_turn("first")
    await capture.final_turn("second")
    await capture.finish()
    assert calls == [(1, "first"), (1, "first"), (2, "second"), "end"]


@pytest.mark.asyncio
async def test_cancelled_capture_retried_at_end():
    entered = asyncio.Event()
    calls = []

    async def append(ordinal, text):
        calls.append((ordinal, text))
        if len(calls) == 1:
            entered.set()
            await asyncio.Future()

    async def finish():
        calls.append("end")

    capture = VoiceMemoryCapture(append, finish)
    task = asyncio.create_task(capture.final_turn("accepted final STT"))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await capture.finish()
    assert calls == [(1, "accepted final STT"), (1, "accepted final STT"), "end"]


@pytest.mark.asyncio
async def test_oversized_source_never_retained_and_end_failure_retryable():
    calls = []

    async def append(ordinal, text):
        calls.append((ordinal, text))

    async def finish():
        calls.append("end")
        if calls.count("end") == 1:
            raise TimeoutError("ambiguous end")

    capture = VoiceMemoryCapture(append, finish)
    with pytest.raises(ValueError):
        await capture.final_turn("x" * 4001)
    await capture.final_turn("bounded")
    with pytest.raises(TimeoutError):
        await capture.finish()
    await capture.finish()
    assert calls == [(1, "bounded"), "end", "end"]
