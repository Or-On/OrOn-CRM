"""Offline transcript-turn harness for conversational regression tests.

No audio device, provider credential, network call, or production UI is used.
The harness exposes the exact ordered messages and delivery metadata that a
completed STT turn contributes, then accepts a fixture model reply through the
same grounding/sanitization boundary as the live pipeline.
"""

from __future__ import annotations

from dataclasses import dataclass

from oron_agent.conversation_language import (
    conversation_language_instruction,
    normalize_language,
    response_language,
)
from oron_agent.grounding import grounding_instruction, render_reply


@dataclass(frozen=True)
class TurnSnapshot:
    turn_id: str
    messages: tuple[dict[str, str], ...]
    tts_language: str
    assistant_response: str | None
    llm_calls: int
    tts_streams: int


class ConversationHarness:
    def __init__(self, *, default_language: str = "en", system_prompt: str = "") -> None:
        self._language = normalize_language(default_language, "en") or "en"
        self._messages: list[dict[str, str]] = []
        if system_prompt.strip():
            self._messages.append({"role": "system", "content": system_prompt.strip()})
        self._turn = 0
        self._llm_calls = 0
        self._tts_streams = 0

    def simulate_user_turn(
        self,
        text: str,
        *,
        provider_language: str | None,
        assistant_fixture: str | None = None,
    ) -> TurnSnapshot:
        if not text.strip():
            raise ValueError("a completed user turn must contain text")
        self._turn += 1
        detected = normalize_language(provider_language)
        if detected is not None and detected != self._language:
            self._language = detected
            self._messages.append(
                {
                    "role": "system",
                    "content": conversation_language_instruction(self._language),
                }
            )
        self._messages.append({"role": "user", "content": text.strip()})
        self._messages.append(
            {"role": "system", "content": grounding_instruction([], self._language)}
        )
        self._llm_calls += 1
        response = None
        delivery_language = self._language
        if assistant_fixture is not None:
            response = render_reply(assistant_fixture, [], self._language).text
            delivery_language, response = response_language(response, self._language)
            self._messages.append({"role": "assistant", "content": response})
            self._tts_streams += 1
        snapshot = TurnSnapshot(
            turn_id=f"turn-{self._turn}",
            messages=tuple(dict(message) for message in self._messages),
            tts_language=delivery_language,
            assistant_response=response,
            llm_calls=self._llm_calls,
            tts_streams=self._tts_streams,
        )
        # The live context refreshes rather than accumulates evidence policy.
        self._messages = [
            message
            for message in self._messages
            if not message["content"].startswith("VOICE CONVERSATION AND EVIDENCE POLICY v2.")
        ]
        return snapshot
