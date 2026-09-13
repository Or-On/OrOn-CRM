"""Explicit provisional/final recognition boundary for Soniox utterances."""

from __future__ import annotations

import time
from collections import deque

from pipecat.frames.frames import Frame, InterimTranscriptionFrame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


class RecognitionAcceptanceProcessor(FrameProcessor):
    """Accept only provider-finalized text without rewriting the recognition.

    Pipecat 1.8.1's Soniox adapter sets finalized=True only at an endpoint.
    Interim revisions remain usable by transcript/VAD turn-start strategies,
    but do not become TranscriptionFrames for the LLM or preference extractor.
    Token timestamps and the raw provider result stay on the original frame.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._utterance = 0
        self._seen_frames: deque[int] = deque(maxlen=256)
        self.provisional_revisions = 0
        self.accepted_utterances = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction is not FrameDirection.DOWNSTREAM or not isinstance(
            frame, (InterimTranscriptionFrame, TranscriptionFrame)
        ):
            await self.push_frame(frame, direction)
            return
        if frame.id in self._seen_frames:
            return
        self._seen_frames.append(frame.id)
        frame.metadata["recognition_raw_text"] = frame.text
        frame.metadata["recognition_received_ns"] = time.monotonic_ns()
        if isinstance(frame, TranscriptionFrame) and frame.finalized and frame.text.strip():
            self._utterance += 1
            self.accepted_utterances += 1
            frame.metadata.update(
                recognition_state="accepted",
                accepted_utterance_id=self._utterance,
                accepted_text=frame.text,
                recognition_finalized_ns=time.monotonic_ns(),
            )
        else:
            self.provisional_revisions += 1
            frame.metadata["recognition_state"] = "provisional"
            if isinstance(frame, TranscriptionFrame):
                interim = InterimTranscriptionFrame(
                    text=frame.text,
                    user_id=frame.user_id,
                    timestamp=frame.timestamp,
                    language=frame.language,
                    result=frame.result,
                )
                interim.metadata.update(frame.metadata)
                frame = interim
        await self.push_frame(frame, direction)
