"""Transcript capture."""

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
