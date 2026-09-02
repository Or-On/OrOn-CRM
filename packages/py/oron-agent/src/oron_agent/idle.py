"""Idle-caller handling: prompt a silent caller, then end the call.

A caller who stops responding — walked away, put the phone down, lost signal —
would otherwise hold the room until the orphan safety net
(`agent_idle_timeout_secs`) kills the bot with no explanation to whoever is
still listening. This prompts them first, in their own language, and hangs up
only after they have had several chances to answer.

The timer resets on caller speech AND on the bot finishing a turn, so the
countdown measures *silence in the conversation*, not wall-clock since the call
began — a caller listening to a long answer is not idle.
"""

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    EndWorkerFrame,
    Frame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.processors.idle_frame_processor import IdleFrameProcessor
from pydantic import BaseModel


class IdlePolicy(BaseModel):
    """What to do on each successive interval of silence — the whole decision,
    with no pipecat in it, so it is testable without a live pipeline.

    `next_action` returns the prompt to speak, or None meaning "end the call".
    """

    prompts: list[str]
    pokes: int = 0

    def caller_spoke(self) -> None:
        """Reset the allowance: someone who answers is not an idle caller."""
        self.pokes = 0

    def next_action(self) -> str | None:
        if self.pokes >= len(self.prompts):
            return None
        prompt = self.prompts[self.pokes]
        self.pokes += 1
        return prompt


class UserIdlePoker(IdleFrameProcessor):
    """Speaks each prompt in turn on successive idle intervals, then ends the call.

    With the default 15s interval and three prompts a silent caller hears a
    nudge at 15s, another at 30s, a sign-off at 45s, and the call ends at 60s.

    The poke count is instance state rather than a closure flag, mirroring
    `SessionRecorder`. It RESETS whenever the caller speaks: someone who answers
    a nudge and later goes quiet again gets the full allowance a second time,
    which is what a human operator would do.
    """

    def __init__(
        self,
        *,
        prompts: list[str],
        timeout_secs: float,
        **kwargs,
    ):
        super().__init__(
            callback=self._on_idle,
            timeout=timeout_secs,
            # Either party acting resets the countdown, and the bot BEGINNING a
            # turn counts: without it a countdown started at the end of the last
            # turn keeps running through this one.
            types=[
                UserStartedSpeakingFrame,
                BotStartedSpeakingFrame,
                BotStoppedSpeakingFrame,
            ],
            **kwargs,
        )
        self.policy = IdlePolicy(prompts=prompts)
        # The reset above is not enough on its own: a turn longer than the
        # timeout still expires mid-sentence. Heard live 2026-07-26 — the bot
        # started speaking at 02:29:04, asked "are you still there?" at 02:29:13,
        # and finished its own sentence at 02:29:14. Tracked from the frames
        # already listed above: base_output pushes them upstream as well as
        # downstream, which is the only reason those resets reach us here.
        self._bot_speaking = False
        # Nothing to be idle about until somebody is on the call. The pipeline
        # starts when the bot joins the room, which on an OUTBOUND call is before
        # the phone has even rung: unarmed, the agent prompts an empty room and
        # hangs up while the callee is still hearing a ring tone.
        self._armed = False

    def arm(self) -> None:
        """Start watching for silence. Called when the caller actually joins."""
        self._armed = True
        self.policy.caller_spoke()
        self.rearm()

    def rearm(self) -> None:
        """Restart the countdown, leaving the caller's allowance alone.

        Not `arm()`: a turn that VAD opened and no transcript ever closed is not
        evidence the caller answered, so restoring the allowance there would let
        a line that is silent apart from breathing hold the call open forever.
        """
        # pipecat's loop starts on StartFrame and re-waits a full interval after
        # each timeout without resetting, so without this the countdown inherits
        # whatever is left of the window in flight — 1.5s of 15s on 2026-08-04,
        # which poked before the greeting had produced any audio.
        if (idle_event := getattr(self, "_idle_event", None)) is not None:
            idle_event.set()

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        if isinstance(frame, UserStartedSpeakingFrame):
            self.policy.caller_spoke()
        elif isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
        await super().process_frame(frame, direction)

    async def _on_idle(self, _processor: IdleFrameProcessor) -> None:
        if not self._armed:
            return
        if self._bot_speaking:
            # Not idle — WE are talking. Consuming a prompt here would both
            # interrupt the agent and spend one of the caller's chances on
            # silence they were never given a turn to fill. The idle loop
            # re-arms on its own, so returning simply checks again later.
            return
        prompt = self.policy.next_action()
        if prompt is None:
            # Disarming is what makes this once-only: the idle loop re-arms
            # after every timeout, so otherwise the call "ends" again every
            # interval, forever.
            self._armed = False
            logger.info("caller idle after every prompt — ending the call")
            # Not EndFrame downstream — that stops the processors below us but
            # never reaches the worker, so `on_pipeline_finished` never fires and
            # the session goes unfinalized with the SIP leg still open.
            await self.push_frame(EndWorkerFrame(), FrameDirection.UPSTREAM)
            return
        logger.info(f"caller idle — prompt {self.policy.pokes}/{len(self.policy.prompts)}")
        await self.push_frame(TTSSpeakFrame(prompt), FrameDirection.DOWNSTREAM)
