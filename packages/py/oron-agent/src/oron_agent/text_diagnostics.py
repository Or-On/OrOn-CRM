"""Development-only, redacted voice text-stage diagnostics."""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any
from uuid import UUID

_SENSITIVE_DIGITS = re.compile(r"(?<!\d)\d(?:[\s-]*\d){3,}(?!\d)")


def redact_voice_text(value: str) -> str:
    """Remove identifier-shaped digit sequences before a diagnostic artifact exists."""

    return _SENSITIVE_DIGITS.sub("[redacted-number]", value)


class VoiceTextDiagnostics:
    def __init__(
        self,
        output_file: str,
        *,
        session_id: UUID,
        tenant_id: UUID,
        handoff_id: UUID | None,
        verification_state: str,
    ) -> None:
        self._output_file = output_file
        self._session_id = str(session_id)
        self._tenant_id = str(tenant_id)
        self._handoff_id = str(handoff_id) if handoff_id else None
        self._verification_state = verification_state
        self._context_unlocked = verification_state == "context_unlocked"
        self._turn = 0
        self._turns: dict[int, dict[str, Any]] = {}

    def _start_turn(self, *, stt_text: str | None, language: str | None) -> None:
        self._turn += 1
        self._turns[self._turn] = {
            "turn_id": self._turn,
            "session_id": self._session_id,
            "handoff_id": self._handoff_id,
            "tenant_id": self._tenant_id,
            "stt_final_text": redact_voice_text(stt_text) if stt_text is not None else None,
            "stt_language": language,
            "llm_response_text": None,
            "tts_input_text": [],
            "verification_state": self._verification_state,
            "context_unlock_state": "unlocked" if self._context_unlocked else "locked",
        }

    def set_verification_state(self, state: str) -> None:
        self._verification_state = state
        self._context_unlocked = state == "context_unlocked"

    def record_stt(self, text: str, language: str) -> None:
        self._start_turn(stt_text=text, language=language)

    def record_llm(self, text: str) -> None:
        if not self._turn:
            self._start_turn(stt_text=None, language=None)
        self._turns[self._turn]["llm_response_text"] = redact_voice_text(text)

    def record_tts(self, text: str) -> None:
        if text.strip():
            if not self._turn:
                self._start_turn(stt_text=None, language=None)
            self._turns[self._turn]["tts_input_text"].append(redact_voice_text(text))

    async def finalize(self, quality: dict[str, Any]) -> None:
        quality_turns = {
            item.get("turn_index"): item.get("durations_ms", {})
            for item in quality.get("turns", [])
            if isinstance(item, dict)
        }
        result: list[dict[str, Any]] = []
        for turn_id, turn in self._turns.items():
            durations = quality_turns.get(turn_id, {})
            result.append(
                {
                    **turn,
                    "tts_input_text": " ".join(turn["tts_input_text"]).strip() or None,
                    "endpoint_latency": durations.get("speech_end_to_accepted_ms"),
                    "llm_first_token_latency": durations.get("model_first_token_ms"),
                    "tts_first_audio_latency": durations.get("validated_to_synthesis_ms"),
                }
            )
        payload = {
            "schemaVersion": "1.0",
            "developmentOnly": True,
            "redaction": "identifier-shaped digit sequences removed before persistence",
            "turns": result,
        }
        await asyncio.to_thread(
            Path(self._output_file).write_text,
            json.dumps(payload, ensure_ascii=False, indent=2),
            "utf-8",
        )
