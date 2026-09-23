"""Voice enforcement of the shared service-agent scope policy.

Three seams, all before audio exists:

* :class:`ServiceScopeRouter` sits immediately before the LLM. A caller turn
  the policy routes (model/prompt probing, instruction overrides, requests for
  other customers' data or another recipient, general-purpose tasks) is
  answered with the approved server response and never reaches the model. A
  mixed turn that also carries a service request reaches the model with a
  scope notice, so a refusal never discards a legitimate inquiry.
* :class:`ServiceScopeOutputGate` sits after the response-language processor,
  where each chunk is the exact text TTS will receive. A rejected chunk is
  replaced by the approved fallback and the rest of that generation is dropped.
* :class:`ServiceScopeTextFilter` is a TTS text filter. Pipecat applies text
  filters to every utterance it synthesizes, including ``TTSSpeakFrame`` paths
  that never pass the LLM (idle prompts, flow ``tts_say`` actions), so no audio
  path bypasses validation.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

from loguru import logger
from pipecat.frames.frames import (
    AggregatedTextFrame,
    Frame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseStartFrame,
    TTSSpeakFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.utils.text.base_text_filter import BaseTextFilter

from oron_agent.scope_policy import (
    POLICY_VERSION,
    approved_response,
    approved_responses,
    classify_turn,
    scope_notice,
    validate_output,
)

ScopeEvent = Callable[[str, str, str], None]
"""(stage, category, action) — sanitized: never caller or model text."""

_NOTICE_PREFIX = "SERVICE AGENT SCOPE NOTICE"


def _message_text(message: Any) -> str:
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            str(part.get("text", ""))
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    return ""


def _latest_caller_turn(messages: list[Any]) -> tuple[int, str] | None:
    """The newest message when it is a caller turn awaiting its first answer.

    System notices may follow it; anything else (a tool result, an assistant
    line) means this inference continues work that already answered the turn.
    """

    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        role = message.get("role") if isinstance(message, dict) else None
        if role in {"system", "developer"}:
            continue
        if role == "user":
            return index, _message_text(message)
        return None
    return None


class ServiceScopeRouter(FrameProcessor):
    def __init__(
        self,
        *,
        language: Callable[[], str],
        business_name: str | None,
        on_event: ScopeEvent | None = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._language = language
        self._business_name = business_name
        self._on_event = on_event
        self._answered: tuple[int, str] | None = None

    def _event(self, stage: str, category: str, action: str) -> None:
        logger.warning(
            "service scope {} (policy={}, stage={}, category={})",
            action,
            POLICY_VERSION,
            stage,
            category,
        )
        if self._on_event is not None:
            self._on_event(stage, category, action)

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction is not FrameDirection.DOWNSTREAM or not isinstance(frame, LLMContextFrame):
            await self.push_frame(frame, direction)
            return
        messages = frame.context.get_messages()
        # A notice belongs to the turn that raised it, never to later turns.
        cleaned = [
            message
            for message in messages
            if not (
                isinstance(message, dict)
                and message.get("role") == "system"
                and _message_text(message).startswith(_NOTICE_PREFIX)
            )
        ]
        if len(cleaned) != len(messages):
            frame.context.set_messages(cleaned)
            messages = cleaned
        turn = _latest_caller_turn(messages)
        if turn is None or turn == self._answered:
            await self.push_frame(frame, direction)
            return
        decision = classify_turn(turn[1])
        if decision.route is not None:
            # The model never sees this turn as a question to answer: the
            # approved response is the whole reply, spoken through the same
            # TTS filters as everything else and recorded in the context.
            self._answered = turn
            self._event("caller_turn", ",".join(decision.restricted), "routed")
            await self.push_frame(
                TTSSpeakFrame(
                    approved_response(decision.route, self._language(), self._business_name),
                    append_to_context=True,
                ),
                direction,
            )
            return
        if decision.mixed:
            self._event("caller_turn", ",".join(decision.mixed), "scope_notice")
            frame.context.add_message({"role": "system", "content": scope_notice(decision.mixed)})
        await self.push_frame(frame, direction)


class ServiceScopeOutputGate(FrameProcessor):
    def __init__(
        self,
        *,
        language: Callable[[], str],
        business_name: str | None,
        on_event: ScopeEvent | None = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._language = language
        self._business_name = business_name
        self._approved = approved_responses(business_name)
        self._on_event = on_event
        self._suppressing = False
        self._turn_text = ""

    def _reset(self) -> None:
        self._suppressing = False
        self._turn_text = ""

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction is FrameDirection.DOWNSTREAM and isinstance(
            frame, (LLMFullResponseStartFrame, InterruptionFrame)
        ):
            self._reset()
        if direction is FrameDirection.DOWNSTREAM and isinstance(frame, AggregatedTextFrame):
            if self._suppressing:
                # The rest of a rejected generation is never spoken.
                return
            text = frame.text or ""
            accumulated = f"{self._turn_text} {text}".strip()
            verdict = validate_output(text, approved=self._approved)
            if verdict.allowed and self._turn_text:
                # Catch a disclosure split across two speech chunks before the
                # second half is spoken.
                verdict = validate_output(accumulated, approved=self._approved)
            if not verdict.allowed:
                self._suppressing = True
                fallback = approved_response("fallback", self._language(), self._business_name)
                frame.text = fallback
                frame.raw_text = fallback
                frame.metadata["scope"] = {
                    "policy": POLICY_VERSION,
                    "decision": "rejected",
                    "category": verdict.category,
                }
                logger.warning(
                    "service scope rejected model speech before TTS (policy={}, category={})",
                    POLICY_VERSION,
                    verdict.category,
                )
                if self._on_event is not None:
                    self._on_event("model_output", str(verdict.category), "rejected")
            else:
                self._turn_text = accumulated[-4000:]
        await self.push_frame(frame, direction)


class ServiceScopeTextFilter(BaseTextFilter):
    """Final stateless check on every utterance handed to speech synthesis."""

    def __init__(
        self,
        *,
        language: Callable[[], str],
        business_name: str | None,
        on_event: ScopeEvent | None = None,
    ):
        self._language = language
        self._business_name = business_name
        self._approved = approved_responses(business_name)
        self._on_event = on_event

    async def filter(self, text: str) -> str:
        verdict = validate_output(text, approved=self._approved)
        if verdict.allowed:
            return text
        logger.warning(
            "service scope rejected text at the synthesis boundary (policy={}, category={})",
            POLICY_VERSION,
            verdict.category,
        )
        if self._on_event is not None:
            self._on_event("synthesis", str(verdict.category), "rejected")
        return approved_response("fallback", self._language(), self._business_name)


def background_event_recorder(
    record: Callable[[str, str, str], Any] | None,
) -> ScopeEvent:
    """Persist sanitized scope events without delaying speech.

    Recording is best-effort by design: a failed audit write must never keep an
    approved answer from being spoken, and the log line above is always written.
    """

    pending: set[asyncio.Task[Any]] = set()

    def emit(stage: str, category: str, action: str) -> None:
        if record is None:
            return

        async def write() -> None:
            try:
                async with asyncio.timeout(2.0):
                    await record(stage, category, action)
            except Exception:
                logger.warning("service scope event could not be persisted")

        try:
            task = asyncio.get_running_loop().create_task(write())
        except RuntimeError:
            return
        pending.add(task)
        task.add_done_callback(pending.discard)

    return emit
