"""A stereo recorder whose two channels share one timeline.

`AudioBufferProcessor` pads whichever buffer is behind with silence so the
caller and agent channels line up — but skips that padding while either party
is flagged as speaking, to avoid inserting silence mid-utterance and crackling.
Every skipped pad is drift that is never repaid, and it accumulates: measured
at ~3-4 s over a 36 s call, which is enough to put the bot's voice in the
caller channel at a time the agent channel is silent.

Upstream's trade is right for a recording someone listens to and wrong for one
something measures. Barge-in, overlap and any "who spoke when" analysis reads
the offset between the channels, and silently gets it wrong.
"""

from __future__ import annotations

from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor


class AlignedAudioBufferProcessor(AudioBufferProcessor):
    """Stereo recording with the silence padding never skipped.

    Costs some crackling where padding lands mid-utterance. Buys a recording
    whose two channels can be compared in time at all.
    """

    def __init__(self, **kwargs):
        if kwargs.get("enable_turn_audio"):
            # Turn recording reads the same speaking flags this class pins to
            # False, so it would silently attribute every turn to nobody.
            raise ValueError("AlignedAudioBufferProcessor cannot record turn audio")
        super().__init__(**kwargs)

    # Pinned False so the sync in _process_recording always runs. Settable
    # because the base class assigns to both on every speaking frame.
    @property
    def _user_speaking(self) -> bool:
        return False

    @_user_speaking.setter
    def _user_speaking(self, _value: bool) -> None:
        pass

    @property
    def _bot_speaking(self) -> bool:
        return False

    @_bot_speaking.setter
    def _bot_speaking(self, _value: bool) -> None:
        pass
