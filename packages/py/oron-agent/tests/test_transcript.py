"""Transcript capture."""

import asyncio
import threading

import pytest
from oron_agent.transcript import TranscriptHandler, TranscriptMessage


async def test_a_cut_off_assistant_line_says_so(tmp_path):
    """Without the marker an interrupted line reads as a complete one, and the
    transcript cannot answer whether the bot was talked over."""
    out = tmp_path / "t.txt"
    handler = TranscriptHandler(output_file=str(out))
    await handler.save_message(
        TranscriptMessage(role="assistant", content="שלום, שמי", interrupted=True)
    )
    await handler.save_message(TranscriptMessage(role="assistant", content="יום טוב"))

    lines = out.read_text(encoding="utf-8").splitlines()
    assert lines[0] == "assistant [interrupted]: שלום, שמי"
    assert lines[1] == "assistant: יום טוב"


async def test_completed_transcript_is_finalized_in_event_time_order(tmp_path):
    out = tmp_path / "t.txt"
    handler = TranscriptHandler(output_file=str(out))
    await handler.save_message(
        TranscriptMessage(
            role="assistant", content="still there?", timestamp="2026-09-10T10:55:19+00:00"
        )
    )
    await handler.save_message(
        TranscriptMessage(role="user", content="yes", timestamp="2026-09-10T10:55:12+00:00")
    )

    assert await handler.finalize()

    lines = out.read_text(encoding="utf-8").splitlines()
    assert lines[0].endswith("user: yes")
    assert lines[1].endswith("assistant: still there?")


async def test_cancelled_append_finishes_before_final_rewrite(tmp_path, monkeypatch):
    out = tmp_path / "t.txt"
    handler = TranscriptHandler(output_file=str(out))
    entered, release = threading.Event(), threading.Event()
    original_append = handler._append_line

    def slow_append(line):
        entered.set()
        assert release.wait(timeout=5)
        original_append(line)

    monkeypatch.setattr(handler, "_append_line", slow_append)
    capture = asyncio.create_task(
        handler.save_message(TranscriptMessage(role="user", content="Final complete turn"))
    )
    finalization = None
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        capture.cancel()
        finalization = asyncio.create_task(handler.finalize())
        await asyncio.sleep(0)
        assert not capture.done()
        assert not finalization.done()
        capture.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await capture
        assert await finalization
    finally:
        release.set()
        await asyncio.gather(
            capture, *([finalization] if finalization is not None else []), return_exceptions=True
        )
    assert out.read_text() == "user: Final complete turn\n"


async def test_failed_final_rewrite_keeps_the_journal_available_for_retry(tmp_path, monkeypatch):
    out = tmp_path / "t.txt"
    handler = TranscriptHandler(output_file=str(out))
    await handler.save_message(TranscriptMessage(role="user", content="Retained turn"))
    original_replace = handler._replace_lines

    def failure(_lines):
        raise OSError("Fictional storage failure")

    monkeypatch.setattr(handler, "_replace_lines", failure)
    assert await handler.finalize() is False
    assert out.read_text() == "user: Retained turn\n"
    monkeypatch.setattr(handler, "_replace_lines", original_replace)
    assert await handler.finalize() is True
