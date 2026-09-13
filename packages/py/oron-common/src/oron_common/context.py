import uuid
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field


class Direction(StrEnum):
    """Which side placed the call.

    BROWSER is not a third side — it is the console's mic with no PSTN leg at
    all. It exists because a test call recorded as `inbound` is indistinguishable
    from a voter's, which silently mixes rehearsals into the campaign's numbers.
    """

    INBOUND = "inbound"
    OUTBOUND = "outbound"
    BROWSER = "browser"


def new_session_id() -> uuid.UUID:
    """Fresh UUID4 — the primary key for a session (recording, API record)."""
    return uuid.uuid4()


class CallContext(BaseModel):
    """Per-call context handed from the transport layer to the agent."""

    call_id: str
    # The transport, not the carrier — carriers are swapped in the SIP trunk's
    # allowed_addresses and never reach the agent.
    provider: Literal["livekit"] = "livekit"
    direction: Direction
    from_number: str | None = None
    to_number: str | None = None
    # Bound from the dialed DID inbound, stated by the caller outbound.
    flow_id: uuid.UUID
    # Optional immutable bindings from the authenticated dispatch command.
    # Older callers may omit these; the runtime resolves their published flow.
    flow_version: int | None = Field(default=None, ge=1, strict=True)
    agent_version_id: uuid.UUID | None = None
    # Required: a call is only ever served for a known tenant — inbound the DID
    # must resolve to one, outbound the caller names one. The agent needs it to
    # fetch its flow, so it travels with the call rather than beside it.
    tenant_id: uuid.UUID
    session_id: uuid.UUID = Field(default_factory=new_session_id)
    # Chosen per call (e.g. to match the caller's gender); falls back to the
    # GEMINI_TTS_VOICE default in Settings when the transport doesn't set it.
    tts_voice: str | None = None
    # A trusted operator/contact preference, never an acoustic guess. Hebrew
    # address forms cannot be reliably made neutral in every sentence, so an
    # outbound caller may bind one form for the complete call.
    caller_gender: Literal["male", "female"] | None = None
    # Optional cross-channel provenance. The transcript is bounded at admission
    # and treated as untrusted reference material by the voice agent.
    source_conversation_id: uuid.UUID | None = None
    conversation_context: str | None = Field(default=None, max_length=4000)
    raw_metadata: dict = Field(default_factory=dict)
