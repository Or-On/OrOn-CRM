"""Serialize the conversation with exactly one provider system instruction.

The voice context legitimately holds several instruction messages: the tenant
role that FlowManager installs as the service ``system_instruction``, node task
messages, the model-authored opener, caller language and address updates, the
per-turn evidence policy, and Pipecat's ``developer`` tool-status notes.

Google's Gemini OpenAI-compatible endpoint keeps only the LAST ``system`` or
``developer`` message of a request and silently discards the rest. Measured on
2026-09-18 against ``gemini-2.5-flash``: with an identity system message
followed by any second system/developer message, 18/18 replies said "I am a
large language model, trained by Google"; one merged system message kept the
configured identity 3/3, and a later instruction in the same request was
applied while an earlier one was ignored. In the live pipeline the last one was always the
evidence policy, so every turn lost the tenant identity and the CRM prompt.
The native Gemini adapter has the mirror-image rule: it discards an initial
context system message whenever a service instruction is set.

Folding every instruction into one leading message, in their original order,
preserves each instruction's text and relative precedence on every provider.
Caller, assistant and tool messages keep their order and content untouched.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

INSTRUCTION_ROLES = frozenset({"system", "developer"})

CALL_START_EVENT = (
    "Platform call-start event (not customer speech): the telephone connection is "
    "active. Begin according to the trusted flow objective and conversation context."
)


def _text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            str(part.get("text", ""))
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    return ""


def is_instruction(message: object) -> bool:
    return isinstance(message, dict) and message.get("role") in INSTRUCTION_ROLES


def fold_instructions(
    messages: Sequence[Any], system_instruction: str | None = None
) -> tuple[str | None, list[Any]]:
    """Return one ordered instruction text and the remaining conversation.

    ``system_instruction`` (the tenant role) always comes first. When nothing
    conversational remains — an outbound opener before the caller has spoken —
    a transport event that is explicitly not customer speech is appended so
    providers that require a non-system turn accept the request.
    """

    parts = (
        [system_instruction.strip()] if system_instruction and system_instruction.strip() else []
    )
    conversation: list[Any] = []
    for message in messages:
        if is_instruction(message):
            # No de-duplication: a repeated update (for example a caller who
            # switches address form and back) must stay last to keep precedence.
            if text := _text(message.get("content")).strip():
                parts.append(text)
        else:
            conversation.append(message)
    if not conversation:
        conversation.append({"role": "user", "content": CALL_START_EVENT})
    return ("\n\n".join(parts) or None), conversation
